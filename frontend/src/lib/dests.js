// The app's screens, as one list: the Board, the seven sub-views inside the consolidated tabs, and
// Settings. ⌘K lists the sub-views from it; the desktop's "Report a problem" sweep walks all nine
// (in `?snap=1` mode), and the report opener on the owner's side accepts exactly these ids
// (ops/feedback-bot/opener/dests.py, pinned to this file by a test).
export const DESTS = [
  { id: 'board', section: 'Board', sub: null, label: 'Board' },
  { id: 'strategy-hold', section: 'Strategy', sub: 'hold', label: 'Hold' },
  { id: 'strategy-arbitrage', section: 'Strategy', sub: 'arbitrage', label: 'Arbitrage' },
  { id: 'economy-inflation', section: 'Economy', sub: 'inflation', label: 'Inflation' },
  { id: 'economy-market', section: 'Economy', sub: 'market', label: 'Market' },
  { id: 'trading-workspace', section: 'Trading', sub: 'workspace', label: 'Workspace' },
  { id: 'trading-live', section: 'Trading', sub: 'live', label: 'Live' },
  { id: 'trading-sales', section: 'Trading', sub: 'sales', label: 'Sales' },
  { id: 'settings', section: 'Settings', sub: null, label: 'Settings' },
]

// Sub-views inside the consolidated tabs, surfaced in ⌘K so they stay one keystroke away.
export const SUB_DESTS = DESTS.filter(d => d.sub).map(({ section, sub, label }) => ({ section, sub, label }))

// `?snap=1`: the hidden window the feedback sweep photographs. Under it the app renders every screen
// but never polls, notifies, persists or mounts the trade <webview>.
export const SNAP_PARAM = 'snap'
export const SNAP = typeof location !== 'undefined' && new URLSearchParams(location.search).get(SNAP_PARAM) === '1'

// Under SNAP, count in-flight fetches so a screen is photographed once ITS data has landed: quiet
// (nothing in flight) for `quietMs`, capped at `maxMs`. Views fetch on mount; two frames is too early.
let inflight = 0
if (SNAP && typeof window !== 'undefined' && window.fetch) {
  const orig = window.fetch
  window.fetch = (...a) => { inflight++; return orig(...a).finally(() => { inflight-- }) }
}
export function settle({ quietMs = 250, maxMs = 2000 } = {}) {
  const t0 = Date.now()
  let quietSince = null
  return new Promise(res => {
    const tick = () => {
      const now = Date.now()
      if (inflight === 0) { if (quietSince == null) quietSince = now; if (now - quietSince >= quietMs) return res() }
      else quietSince = null
      if (now - t0 >= maxMs) return res()
      setTimeout(tick, 50)
    }
    tick()
  })
}
