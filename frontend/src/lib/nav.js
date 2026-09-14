// Tiny nav event bus: lets the command palette (or anything) ask a view to focus
// something — e.g. open a currency's detail on the Board — without prop-drilling.
const subs = new Set()
export const nav = {
  on(fn) { subs.add(fn); return () => subs.delete(fn) },
  openCurrency(id) { subs.forEach(f => { try { f({ type: 'openCurrency', id }) } catch {} }) },
  // Ask the Trading tab to switch to one of its sub-views ('browse' | 'watches' | 'live').
  openTrading(sub) { subs.forEach(f => { try { f({ type: 'openTrading', sub }) } catch {} }) },
  // Ask a section container (Strategy/Economy) to switch to a sub-view.
  openSub(section, sub) { subs.forEach(f => { try { f({ type: 'openSub', section, sub }) } catch {} }) },
  // Ask the Trading tab to jump to Live and focus the newest ping (hotkey / orb click).
  focusLive() { subs.forEach(f => { try { f({ type: 'focusLive' }) } catch {} }) },
}
