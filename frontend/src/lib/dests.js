// The app's screens, as ONE list: the Board, every sub-view inside the consolidated tabs (in the order
// the tabs show them) and Settings. Each section's sub-tabs are its slice (`subsOf`), ⌘K lists the
// sub-views from it, the desktop's "Report a problem" sweep walks all of them (in `?snap=1` mode), and
// the report opener on the owner's side accepts exactly these ids (ops/feedback-bot/opener/dests.py,
// pinned to this file by a test). A sub-view added anywhere else is missing from reports and ⌘K.
export const DESTS = [
  { id: 'board', section: 'Board', sub: null, label: 'Board', aka: ['prices', 'price board'] },
  { id: 'strategy-arbitrage', section: 'Strategy', sub: 'arbitrage', label: 'Arbitrage', aka: ['flip', 'loop', 'convert'] },
  { id: 'strategy-hold', section: 'Strategy', sub: 'hold', label: 'Hold', aka: ['invest', 'swing', 'movers', 'rising', 'pumping', 'what to buy'] },
  { id: 'strategy-calc', section: 'Strategy', sub: 'calc', label: 'Strat Calculator', aka: ['farm', 'profit per hour'] },
  { id: 'economy-inflation', section: 'Economy', sub: 'inflation', label: 'Inflation', aka: ['deflation', 'div ex ratio'] },
  { id: 'economy-market', section: 'Economy', sub: 'market', label: 'Market', aka: ['pairs', 'busiest', 'volume'] },
  { id: 'trading-workspace', section: 'Trading', sub: 'workspace', label: 'Workspace', aka: ['trade', 'searches'] },
  { id: 'trading-live', section: 'Trading', sub: 'live', label: 'Live', aka: ['ping', 'live search'] },
  { id: 'trading-sales', section: 'Trading', sub: 'sales', label: 'Stash', aka: ['Sales', 'net worth', 'what I have', 'holdings'] },   // renamed 2026-10-03; ⌘K still finds the old name
  { id: 'trading-regex', section: 'Trading', sub: 'regex', label: 'Regex', aka: ['waystone', 'tablet', 'highlight', 'stash search', 'bulk', 'buy many', 'vendor search'] },
  { id: 'trading-mods', section: 'Trading', sub: 'mods', label: 'Mods', aka: ['affix', 'tier', 'craft', 'modifiers'] },
  { id: 'settings', section: 'Settings', sub: null, label: 'Settings', aka: ['sound', 'notification', 'notifications', 'theme', 'connect', 'login', 'account', 'session'] },
]

// Each screen's ⌘K actions, listed first when ⌘K opens on that screen (owner, 2026-10-05). An action works a
// control the user could click: `target` names the control's `data-cmd` marker in its screen, `act` focuses or
// clicks it (lib/paletteRun.js). Actions without a target are run by App (the Workspace store, the report dialog).
// Never an action that spends the shared trade-history allowance (the Stash's history fetch).
export const SCREEN_COMMANDS = {
  board: [{ id: 'board-add', label: 'Add a currency', target: 'board-add', act: 'focus', aka: ['watch'] }],
  'strategy-arbitrage': [{ id: 'convert', label: 'Convert…', target: 'convert-have', act: 'focus', aka: ['have', 'want'] }],
  'strategy-hold': [{ id: 'hold-category', label: 'Category…', target: 'hold-category', act: 'focus' }],
  'strategy-calc': [   // a focus action first: Enter on a just-opened ⌘K must not start the timer (QA 2026-10-05)
    { id: 'calc-loot', label: 'Add loot…', target: 'calc-loot', act: 'focus', aka: ['drop', 'item'] },
    { id: 'calc-timer', label: 'Start / Stop timer', target: 'calc-timer', act: 'click' },
    { id: 'calc-map', label: 'Add map +1', target: 'calc-map', act: 'click', aka: ['maps run'] },
    { id: 'calc-new', label: 'New strat', target: 'calc-new', act: 'click' },
  ],
  'economy-inflation': [{ id: 'inflation-anchor', label: 'Change anchor…', target: 'inflation-anchor', act: 'focus' }],
  'economy-market': [
    { id: 'market-pair', label: 'Pick a pair…', target: 'market-pair', act: 'focus', aka: ['chart'] },
    { id: 'market-filter', label: 'Filter markets…', target: 'market-filter', act: 'focus' },
  ],
  'trading-workspace': [
    { id: 'ws-new-search', label: 'New search', keys: '⌘N' },
    { id: 'ws-new-group', label: 'New group', keys: '⌘⇧N', aka: ['folder'] },
    { id: 'ws-clipboard', label: 'Add from clipboard', keys: '⌘⇧V', aka: ['paste'] },
    { id: 'ws-sort', label: 'Sort searches A–Z' },
    { id: 'ws-toggle-rail', label: 'Toggle searches rail', aka: ['sidebar'] },
    { id: 'ws-clear-history', label: 'Clear EE2 history' },
  ],
  'trading-live': [{ id: 'live-ping', label: 'Jump to newest ping', keys: '⌘G', target: 'live-ping', act: 'focus', aka: ['teleport', 'travel', 'hideout'] }],
  'trading-sales': [
    { id: 'stash-add', label: 'Add a currency', target: 'stash-add', act: 'focus' },
    { id: 'stash-find', label: 'Find in stash', target: 'stash-find', act: 'focus' },
  ],
  'trading-regex': [   // first: a focus action — Enter on a just-opened ⌘K must not touch the clipboard (QA pass 2)
    { id: 'regex-include', label: 'Filter modifiers…', target: 'regex-include', act: 'focus' },
    { id: 'regex-copy', label: 'Copy regex', target: 'regex-copy', act: 'click' },
    { id: 'regex-waystones', label: 'Waystones', target: 'regex-waystones', act: 'click' },
    { id: 'regex-tablets', label: 'Tablets', target: 'regex-tablets', act: 'click' },
  ],
  'trading-mods': [
    { id: 'mods-filter', label: 'Filter modifiers…', target: 'mods-filter', act: 'focus' },
    { id: 'mods-type', label: 'Item type…', target: 'mods-type', act: 'focus', aka: ['base'] },
    { id: 'mods-paste', label: 'Paste item', target: 'mods-paste', act: 'click' },
  ],
  settings: [   // Report a problem packages a report as it opens: not the first row
    { id: 'settings-test-sound', label: 'Test ping sound', target: 'settings-test-sound', act: 'click', aka: ['tone'] },
    { id: 'send-feedback', label: 'Report a problem…', aka: ['bug', 'feedback'] },
  ],
}

// One section's sub-tabs, for its SubTabs bar.
export const subsOf = (section) => DESTS.filter(d => d.section === section && d.sub).map(d => ({ id: d.sub, label: d.label }))

// Sub-views inside the consolidated tabs, surfaced in ⌘K so they stay one keystroke away.
export const SUB_DESTS = DESTS.filter(d => d.sub).map(({ section, sub, label, aka }) => ({ section, sub, label, aka }))

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
