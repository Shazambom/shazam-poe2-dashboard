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
  // Ask a section container (Strategy/Economy) to switch to a sub-view.
  openSub(section, sub) { subs.forEach(f => { try { f({ type: 'openSub', section, sub }) } catch {} }) },
  // Ask the Trading tab to jump to Live and focus the newest ping (hotkey / orb click).
  focusLive() { subs.forEach(f => { try { f({ type: 'focusLive' }) } catch {} }) },
}
