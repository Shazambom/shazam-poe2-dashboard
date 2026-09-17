// The "actions layer" for ExiledExchange2 History (roadmap §9): subscribes to the EE2 package's
// item-checked events (the package stays untouched), asks the worker for the query, and hands the
// renderer ONE IngestIntent per item over 'trade:ingest'. Raw clipboard text never crosses IPC.
//
//   createHistoryConsumer({ manager, worker, prefs, send, log, now }) → { setEnabled, setSender, status, stop, onItem }
//     manager: the ExiledExchangeIntegration emitter   worker: { spawn() → { build(raw, prefs), kill() } }
//     prefs():  { prefs, source }                        send(channel, payload) | null while no window
//     log(line): telemetry (marker ee2)                  now(): clock (tests)
'use strict'

const NO_WINDOW_BUFFER = 20
const RESTART_MIN_MS = 5 * 60 * 1000
const WARM_DELAY_MS = 15 * 1000

function createHistoryConsumer({ manager, worker, prefs, send = null, log = () => {}, now = Date.now, hint = null }) {
  let enabled = true            // main assumes on until the renderer says otherwise (fail toward "it works")
  let sender = send
  let proc = null               // { build, kill } from worker.spawn()
  let lastFailure = 0
  let seq = 0
  const held = []               // intents waiting for a window
  let cachedPrefs = null
  let warmTimer = null
  let status = { present: false, running: false, configRead: false, leagueId: null, warm: false }

  const readPrefs = () => { if (!cachedPrefs) cachedPrefs = prefs(); return cachedPrefs }
  const invalidatePrefs = () => { cachedPrefs = null }

  function ensureWorker() {
    if (proc) return proc
    if (lastFailure && now() - lastFailure < RESTART_MIN_MS) return null
    try {
      proc = worker.spawn({ onExit: () => { proc = null; lastFailure = now(); status.warm = false } }); status.warm = true
      if (typeof proc.warm === 'function') proc.warm().then(r => { if (r) log(`warm ms=${r.ms} items=${r.items} stats=${r.stats}`) }).catch(e => log(`warm-fail err="${String(e && e.message || e).slice(0, 160)}"`))
    } catch (e) { lastFailure = now(); proc = null; log(`history-skip reason=worker spawn="${String(e && e.message || e).slice(0, 80)}"`) }
    return proc
  }
  function warm() { if (enabled && !proc) ensureWorker() }

  function emit(intent) {
    if (sender) { try { sender('trade:ingest', intent) } catch {} return }
    if (held.length >= NO_WINDOW_BUFFER) { log('ingest-drop reason=no-window'); return }
    held.push(intent)
  }

  // raw item text → IngestIntent (or null when nothing should be inserted). Shared by the automatic
  // stream (folder ee2-history) and the explicit clipboard paste (folder null, batch 4-A). The
  // clipboard rung ignores `enabled` (that flag gates only the automatic stream).
  async function buildIntent(raw, origin, { folder = null, item = null, source = 'clipboard' } = {}) {
    const p = ensureWorker()
    if (!p) { log(`history-skip reason=worker origin=${origin}`); return null }
    const { prefs: pf } = readPrefs()
    const t0 = now()
    let r
    try { r = await p.build(raw, pf) } catch (e) {
      const msg = String(e && e.message || e)
      lastFailure = now(); try { p.kill?.() } catch {}; proc = null; status.warm = false
      log(`history-skip reason=${/timeout/i.test(msg) ? 'timeout' : 'worker'} origin=${origin} err="${msg.slice(0, 160)}"`)
      return null
    }
    const id = `i_${now()}_${++seq}`
    const base = { id, source, origin, folder, cfgLeague: pf.leagueId || null, ts: now(), buildMs: typeof r.buildMs === 'number' ? r.buildMs : now() - t0 }
    if (r.error) {
      if (r.error.stage === 'currency') { log(`history-skip reason=currency origin=${origin}`); return null }
      const name = String(item?.name || item?.baseType || 'Unknown item').slice(0, 60)
      log(`history-degraded stage=${r.error.stage} name="${name}"`)
      return { ...base, q: null, degraded: true, stage: r.error.stage, name, item: { name: item?.name || '', baseType: item?.baseType || '', rarity: item?.rarity || '', itemClass: item?.itemClass || '' } }
    }
    log(`history-build origin=${origin} rarity=${r.item?.rarity || item?.rarity || '?'} name="${String(r.name).slice(0, 40)}" ms=${base.buildMs} qb=${Buffer.byteLength(r.q, 'utf8')}`)
    return { ...base, q: r.q, degraded: false, stage: null, name: r.name, item: r.item }
  }

  async function onItem(item) {
    const origin = item && item.origin ? item.origin : 'clipboard'
    // 4-B: an EE2 price check hits GGG's trade API on the same account/IP — spend a slot of the shared budget.
    if (origin === 'ee2' && hint) { try { hint('trade-fetch') } catch {} }
    if (!enabled) { log(`history-skip reason=disabled origin=${origin}`); return }
    const raw = item && typeof item.raw === 'string' ? item.raw : ''
    if (!raw) { log(`history-skip reason=empty origin=${origin}`); return }
    const intent = await buildIntent(raw, origin, { folder: 'ee2-history', item, source: 'ee2' })
    if (intent) emit(intent)
  }

  const onDetected = (info) => {
    status = { ...status, present: !!info?.present, running: !!info?.running, configRead: !!info?.config }
    const { prefs: pf, source } = readPrefs()
    status.leagueId = pf.leagueId || null
    log(`history-attached cfg=${source === 'ee2' ? 'ok' : 'default'} league="${pf.leagueId || ''}"`)
    if (info?.running) { clearTimeout(warmTimer); warmTimer = setTimeout(warm, info.initial ? WARM_DELAY_MS : 0); if (warmTimer.unref) warmTimer.unref(); if (!info.initial) warm() }
  }
  const onMissing = () => { status = { ...status, present: false, running: false } }
  const onError = () => {}

  manager.on('item-checked', onItem)
  manager.on('ee2-detected', onDetected)
  manager.on('ee2-missing', onMissing)
  manager.on('config-changed', invalidatePrefs)
  manager.on('error', onError)

  return {
    onItem, warm, invalidatePrefs,
    buildIntent: (raw, origin = 'clipboard') => buildIntent(String(raw || ''), origin, { folder: null, source: 'clipboard' }),
    setEnabled(v) { enabled = !!v; if (!enabled && proc) { try { proc.kill?.() } catch {}; proc = null; status.warm = false } },
    setSender(fn) { sender = fn; if (fn) { const q = held.splice(0); for (const i of q) { try { fn('trade:ingest', i) } catch {} } } },
    status() { return { ...status, enabled, held: held.length } },
    stop() {
      clearTimeout(warmTimer)
      manager.off('item-checked', onItem); manager.off('ee2-detected', onDetected); manager.off('ee2-missing', onMissing); manager.off('config-changed', invalidatePrefs); manager.off('error', onError)
      try { proc?.kill?.() } catch {}; proc = null
    },
  }
}

module.exports = { createHistoryConsumer, NO_WINDOW_BUFFER, RESTART_MIN_MS, WARM_DELAY_MS }
