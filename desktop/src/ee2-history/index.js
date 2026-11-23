// The "actions layer" for ExiledExchange2 History (roadmap §9): subscribes to the EE2 package's
// item-checked events (the package stays untouched), asks the worker for the query, and hands the
// renderer ONE IngestIntent per item over 'trade:ingest'. Raw clipboard text never crosses IPC.
//
//   createHistoryConsumer({ manager, worker, prefs, send, log, now, onBuilt }) → { setEnabled, setSender, status, stop, onItem }
//     onBuilt(intent): every built (non-degraded) intent, any origin — the dev diagnostic's hook
//     manager: the ExiledExchangeIntegration emitter   worker: { spawn() → { build(raw, prefs), kill() } }
//     prefs():  { prefs, source }                        send(channel, payload) | null while no window
//     log(line): telemetry (marker ee2)                  now(): clock (tests)
'use strict'
const { ignored } = require('../ignored.js')
const { refineQuery } = require('./refine.js')

const NO_WINDOW_BUFFER = 20
const RESTART_MIN_MS = 5 * 60 * 1000
const WARM_DELAY_MS = 15 * 1000

// How many stat filters a built search ticks and leaves off (beta: compare with EE2's window).
function ticks(q) {
  try {
    const fs = (JSON.parse(q).query?.stats || []).flatMap(s => s.filters || [])
    const off = fs.filter(f => f.disabled).length
    return `on=${fs.length - off} off=${off}`
  } catch { return 'on=? off=?' }
}

// A degraded intent's name and item: what EE2's own item-checked event said about the item.
function degradedItem(item) {
  return {
    name: String(item?.name || item?.baseType || 'Unknown item').slice(0, 60),
    item: { name: item?.name || '', baseType: item?.baseType || '', rarity: item?.rarity || '', itemClass: item?.itemClass || '' },
  }
}

/**
 * @param {{ manager: import('node:events').EventEmitter, worker: { spawn: (opts?: { onExit?: (info?: { idle?: boolean }) => void }) => any },
 *   prefs: () => any | Promise<any>, send?: ((channel: string, payload: any) => void) | null, log?: (line: string) => void,
 *   now?: () => number, hint?: ((policy: string) => void) | null, onBuilt?: ((intent: any) => void) | null }} deps
 */
function createHistoryConsumer({ manager, worker, prefs, send = null, log = () => {}, now = Date.now, hint = null, onBuilt = null }) {
  let enabled = true            // main assumes on until the renderer says otherwise (fail toward "it works")
  let sender = send
  let proc = null               // { build, kill } from worker.spawn()
  let lastFailure = 0
  let seq = 0
  const held = []               // intents waiting for a window
  let cachedPrefs = null         // the prefs read (a promise): callers that overlap share it
  let warmTimer = null
  let stopped = false           // stop() ran: a prefs read that finishes afterwards starts nothing
  let status = { present: false, running: false, configRead: false, leagueId: null, warm: false }

  const readPrefs = () => { if (!cachedPrefs) { cachedPrefs = Promise.resolve(prefs()) } return cachedPrefs }
  let searchPrefs = { waystoneStats: true }
  const invalidatePrefs = () => { cachedPrefs = null }

  function ensureWorker() {
    if (proc) return proc
    if (lastFailure && now() - lastFailure < RESTART_MIN_MS) return null
    try {
      proc = worker.spawn({ onExit: (info) => { proc = null; if (!info?.idle) { lastFailure = now() } status.warm = false } }); status.warm = true
      if (typeof proc.warm === 'function') proc.warm().then(r => { if (r) log(`warm ms=${r.ms} items=${r.items} stats=${r.stats}`) }).catch(e => log(`warm-fail err="${String(e && e.message || e).slice(0, 160)}"`))
    } catch (e) { lastFailure = now(); proc = null; log(`history-skip reason=worker spawn="${String(e && e.message || e).slice(0, 80)}"`) }
    return proc
  }
  function warm() { if (enabled && !proc) ensureWorker() }

  function emit(intent) {
    if (sender) { try { sender('trade:ingest', intent) } catch (e) { ignored('ee2-history:send-intent', e) } return }
    if (held.length >= NO_WINDOW_BUFFER) { log('ingest-drop reason=no-window'); return }
    held.push(intent)
  }

  // raw item text → IngestIntent (or null when nothing should be inserted). Shared by the automatic
  // stream (folder ee2-history) and the explicit clipboard paste (folder null, batch 4-A). The
  // clipboard rung ignores `enabled` (that flag gates only the automatic stream).
  // A build that threw or timed out: the worker is dropped (re-spawned later, at most once per
  // RESTART_MIN_MS) and the item is skipped.
  function workerFailed(p, e, origin) {
    const msg = String(e && e.message || e)
    lastFailure = now(); try { p.kill?.() } catch (err) { ignored('ee2-history:kill-worker', err) }; proc = null; status.warm = false
    log(`history-skip reason=${/timeout/i.test(msg) ? 'timeout' : 'worker'} origin=${origin} err="${msg.slice(0, 160)}"`)
  }

  async function buildIntent(raw, origin, { folder = null, item = null, source = 'clipboard' } = {}) {
    // The prefs are read before the worker is taken, so the worker is never left waiting on the read.
    // The first read touches the disk: if the stream was switched off or the consumer stopped
    // meanwhile, nothing is spawned for it.
    const { prefs: pf } = await readPrefs()
    if (stopped) return null
    if (folder && !enabled) { log(`history-skip reason=disabled origin=${origin}`); return null }
    const p = ensureWorker()
    if (!p) { log(`history-skip reason=worker origin=${origin}`); return null }
    const t0 = now()
    let r
    // The user's EE2 settings, unchanged: EE2's window builds its default ticks with the same
    // createPresets options (CheckedItem.vue), so this is the search EE2 opens with (owner, 2026-09-28).
    try { r = await p.build(raw, pf) } catch (e) {
      workerFailed(p, e, origin)
      return null
    }
    const id = `i_${now()}_${++seq}`
    const base = { id, source, origin, folder, cfgLeague: pf.leagueId || null, ts: now(), buildMs: typeof r.buildMs === 'number' ? r.buildMs : now() - t0 }
    if (r.error) {
      if (r.error.stage === 'currency') { log(`history-skip reason=currency origin=${origin}`); return null }
      const degraded = degradedItem(item)
      log(`history-degraded stage=${r.error.stage} name="${degraded.name}"`)
      return { ...base, q: null, degraded: true, stage: r.error.stage, name: degraded.name, item: degraded.item }
    }
    return builtIntent(base, r, raw, item, pf)
  }

  // A built query, refined, logged and handed to the onBuilt hook.
  function builtIntent(base, r, raw, item, pf) {
    // Our refinement on top of EE2's search (refine.js): a waystone also requires its priced stats.
    const q = refineQuery(r.q, raw, { waystoneStats: searchPrefs.waystoneStats, range: pf.searchStatRange })
    const refined = q !== r.q ? ' waystone=refined' : ''
    log(`history-build origin=${base.origin} rarity=${r.item?.rarity || item?.rarity || '?'} name="${String(r.name).slice(0, 40)}" ms=${base.buildMs} qb=${Buffer.byteLength(q, 'utf8')} ${ticks(q)}${refined}`)
    const intent = { ...base, q, degraded: false, stage: null, name: r.name, item: r.item }
    if (onBuilt) { try { onBuilt(intent) } catch (e) { ignored('ee2-history:on-built', e) } }
    return intent
  }

  async function onItem(item) {
    const origin = item && item.origin ? item.origin : 'clipboard'
    // 4-B: an EE2 price check hits GGG's trade API on the same account/IP — a search, then a fetch —
    // so it spends a slot of each shared budget.
    if (origin === 'ee2' && hint) { try { hint('trade-search'); hint('trade-fetch') } catch (e) { ignored('ee2-history:budget-hint', e) } }
    if (!enabled) { log(`history-skip reason=disabled origin=${origin}`); return }
    const raw = item && typeof item.raw === 'string' ? item.raw : ''
    if (!raw) { log(`history-skip reason=empty origin=${origin}`); return }
    const intent = await buildIntent(raw, origin, { folder: 'ee2-history', item, source: 'ee2' })
    if (intent) emit(intent)
  }

  // Presence is recorded at once; the league, the attached line and the warm-up follow the prefs read, in
  // that order as before, unless the consumer was stopped meanwhile.
  async function detected(info) {
    status = { ...status, present: Boolean(info?.present), running: Boolean(info?.running), configRead: Boolean(info?.config) }
    const { prefs: pf, source } = await readPrefs()
    if (stopped) return
    status.leagueId = pf.leagueId || null
    log(`history-attached cfg=${source === 'ee2' ? 'ok' : 'default'} league="${pf.leagueId || ''}" allSel=${Boolean(pf.defaultAllSelected)} range=${pf.searchStatRange} stock=${Boolean(pf.activateStockFilter)}`)
    if (info?.running) { clearTimeout(warmTimer); warmTimer = setTimeout(warm, info.initial ? WARM_DELAY_MS : 0); if (warmTimer.unref) { warmTimer.unref() } if (!info.initial) warm() }
  }
  const onDetected = (info) => { detected(info).catch((e) => ignored('ee2-history:detected', e)) }
  const onMissing = () => { status = { ...status, present: false, running: false } }
  const onError = () => {}

  manager.on('item-checked', onItem)
  manager.on('ee2-detected', onDetected)
  manager.on('ee2-missing', onMissing)
  manager.on('config-changed', invalidatePrefs)
  manager.on('error', onError)

  return {
    onItem, warm, invalidatePrefs,
    // Settings → Trading → ExiledExchange2 searches (the renderer sends it on load and on change).
    setSearchPrefs: (p) => { searchPrefs = { ...searchPrefs, waystoneStats: p?.waystoneStats !== false } },
    buildIntent: (raw, origin = 'clipboard') => buildIntent(String(raw || ''), origin, { folder: null, source: 'clipboard' }),
    // Trading → Mods: the compact parse of an item (never the text) as { item, reason }: reason
    // 'not-item' when the parser refuses the text, 'worker' when there is no worker or it failed,
    // 'timeout' when the parse ran past its budget. A failure counts like a build failure
    // (the restart throttle), a refusal does not.
    async parseItem(raw) {
      const p = ensureWorker()
      if (!p || typeof p.parse !== 'function') { log('mods-parse-skip reason=worker'); return { item: null, reason: 'worker' } }
      let r
      try { r = await p.parse(String(raw || '')) } catch (e) {
        const msg = String(e && e.message || e)
        const reason = /timeout/i.test(msg) ? 'timeout' : 'worker'
        lastFailure = now(); try { p.kill?.() } catch (err) { ignored('ee2-history:kill-worker', err) }; proc = null; status.warm = false
        log(`mods-parse-skip reason=${reason} err="${msg.slice(0, 160)}"`)
        return { item: null, reason }
      }
      if (r && r.error) { log(`mods-parse-skip reason=worker stage=${r.error.stage} err="${String(r.error.message || '').slice(0, 160)}"`); return { item: null, reason: 'worker' } }
      return r ? { item: r, reason: null } : { item: null, reason: 'not-item' }
    },
    setEnabled(v) { enabled = Boolean(v); if (!enabled && proc) { try { proc.kill?.() } catch (e) { ignored('ee2-history:kill-worker', e) }; proc = null; status.warm = false } },
    setSender(fn) { sender = fn; if (fn) { const q = held.splice(0); for (const i of q) { try { fn('trade:ingest', i) } catch (e) { ignored('ee2-history:send-held', e) } } } },
    status() { return { ...status, enabled, held: held.length } },
    stop() {
      stopped = true
      clearTimeout(warmTimer)
      manager.off('item-checked', onItem); manager.off('ee2-detected', onDetected); manager.off('ee2-missing', onMissing); manager.off('config-changed', invalidatePrefs); manager.off('error', onError)
      try { proc?.kill?.() } catch (e) { ignored('ee2-history:kill-worker', e) }; proc = null
    },
  }
}

module.exports = { createHistoryConsumer, NO_WINDOW_BUFFER, RESTART_MIN_MS }
