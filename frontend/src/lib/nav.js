// Tiny nav event bus: lets the command palette (or anything) ask a view to focus
// something — e.g. open a currency's detail on the Board — without prop-drilling.
const subs = new Set()
let pendingTrading = null   // survives the race when TradingView isn't mounted/subscribed yet
export const nav = {
  on(fn) { subs.add(fn); return () => subs.delete(fn) },
  openCurrency(id) { subs.forEach(f => { try { f({ type: 'openCurrency', id }) } catch {} }) },
  // Ask the Trading tab to switch to a sub-view ('workspace' | 'live'). Records a pending
  // target so a freshly-mounting TradingView lands there even if it missed the event.
  openTrading(sub) { pendingTrading = sub; subs.forEach(f => { try { f({ type: 'openTrading', sub }) } catch {} }) },
  consumePendingTrading() { const s = pendingTrading; pendingTrading = null; return s },
  // Ask the app to show the Trading tab at a sub-view (default Workspace: the Strat Calculator's "Open in Trading").
  goTrading(sub = 'workspace') { subs.forEach(f => { try { f({ type: 'goTrading', sub }) } catch {} }) },
  // Ask the app to show the Stash tab (the Arbitrage rail, the top bar's empty state).
  goStash() { subs.forEach(f => { try { f({ type: 'goStash' }) } catch {} }) },
  // Ask a section container (Strategy/Economy) to switch to a sub-view.
  openSub(section, sub) { subs.forEach(f => { try { f({ type: 'openSub', section, sub }) } catch {} }) },
  // A section container reports the sub-view it shows, so App knows the current screen (⌘K lists its actions first).
  reportSub(section, sub) { subs.forEach(f => { try { f({ type: 'sub', section, sub }) } catch {} }) },
}
