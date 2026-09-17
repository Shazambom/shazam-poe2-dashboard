import { useEffect } from 'react'
import { useWorkspace, HISTORY_PREFS, HISTORY_MAX_LIMIT } from './workspaceStore.js'
import { useStatus, ensureSettings } from './statusStore.js'
import { diag } from './diag.js'
import { hasTradeEngine as isDesktop } from './session.js'
import { bus, toast } from './api.js'
import React from 'react'

// 🗑 / context menu / Settings / ⌘K all clear through here: one toast, one undo slot.
export function clearHistoryWithUndo() {
  const undo = useWorkspace.getState().clearHistory()
  if (!undo) { toast('History is already empty'); return null }
  const h = React.createElement
  bus.emit({ id: 'ws-undo', ttl: 10000, node: h('div', { className: 'ws-undo' },
    h('span', { className: 'ws-undo-text' }, `Cleared ${undo.n} ${undo.n === 1 ? 'entry' : 'entries'}`),
    h('button', { className: 'btn small primary', onClick: () => { useWorkspace.getState().restoreHistory(undo); bus.emit({ id: 'ws-undo', dismiss: true }) } }, 'Undo')) })
  return undo
}

// settings.ee2History → the store's historyPrefs (clamped like Settings clamps them).
export function historyPrefsFromSettings(s) {
  const h = s?.ee2History || {}
  const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d }
  return { enabled: h.enabled !== false, max: clamp(h.max, 20, HISTORY_MAX_LIMIT, HISTORY_PREFS.max), retentionDays: clamp(h.retentionDays, 7, 90, HISTORY_PREFS.retentionDays) }
}

// The ONE writer of settings.ee2History: rail slider, Settings sliders and the ⌘K/🗑 actions all go
// through here, so the store and the saved setting never disagree.
export async function saveHistoryPrefs(patch) {
  const ws = useWorkspace.getState()
  const next = { ...ws.historyPrefs, ...patch }
  ws.setHistoryPrefs(next)
  window.poe2desktop?.ee2?.setEnabled?.(next.enabled)
  try { await useStatus.getState().saveSettings({ ee2History: next }) } catch {}
  return next
}

// Telemetry for the renderer half of the flow (names, counts, ages — never q).
function reportHistoryEvent(e) {
  if (!e) return
  const name = String(e.name || '').slice(0, 40)
  if (e.type === 'added' || e.type === 'degraded') diag('ee2', `history-add name="${name}" total=${e.total} league-match=${e.cfgLeague && e.league ? (e.cfgLeague === e.league ? 1 : 0) : '?'}`)
  else if (e.type === 'bumped') diag('ee2', `history-bump name="${name}" age=${e.age}`)
  else if (e.type === 'expire') diag('ee2', `history-expire n=${e.n} oldest=${e.oldestDays}d`)
  else if (e.type === 'clear') diag('ee2', `history-clear n=${e.n}`)
  if (e.pruned) diag('ee2', `history-cap pruned=${e.pruned} total=${e.total}`)
}

// Mounted once in App beside useLiveSync: intents from main → store.ingest → ack; the enabled flag
// to main on mount and on change; prefs from settings; hourly expiry. Inert on web.
export function useEe2History() {
  useEffect(() => {
    ensureSettings().then(s => useWorkspace.getState().setHistoryPrefs(historyPrefsFromSettings(s))).catch(() => {})
    const offEvent = useWorkspace.subscribe((s, prev) => { if (s.lastHistoryEvent && s.lastHistoryEvent !== prev.lastHistoryEvent) reportHistoryEvent(s.lastHistoryEvent) })
    const hourly = setInterval(() => useWorkspace.getState().expireHistory(Date.now()), 3600 * 1000)
    if (!isDesktop || !window.poe2desktop?.trade?.onIngest) return () => { offEvent(); clearInterval(hourly) }
    const handle = (intent) => {
      const r = useWorkspace.getState().ingest(intent)
      try { window.poe2desktop.trade.ingestAck({ id: intent?.id, result: r.result, reason: r.reason }) } catch {}
      return r
    }
    if (import.meta.env.DEV) window.__ee2HistoryTestHook = handle
    const offIngest = window.poe2desktop.trade.onIngest(handle)
    // EE2 presence gates the whole feature's UI; the package re-detects every 30 s, so poll at that cadence.
    const pollPresence = () => window.poe2desktop.ee2?.status?.().then(st => useWorkspace.getState().setEe2Present(!!st?.present)).catch(() => {})
    pollPresence(); const presenceTimer = setInterval(pollPresence, 30000)
    window.poe2desktop.ee2?.setEnabled?.(useWorkspace.getState().historyPrefs.enabled)
    const offEnabled = useWorkspace.subscribe((s, prev) => { if (s.historyPrefs.enabled !== prev.historyPrefs.enabled) window.poe2desktop.ee2?.setEnabled?.(s.historyPrefs.enabled) })
    return () => { offEvent(); clearInterval(hourly); clearInterval(presenceTimer); offIngest?.(); offEnabled() }
  }, [])
}
