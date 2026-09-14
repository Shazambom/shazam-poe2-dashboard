// Tiny nav event bus: lets the command palette (or anything) ask a view to focus
// something — e.g. open a currency's detail on the Board — without prop-drilling.
const subs = new Set()
export const nav = {
  on(fn) { subs.add(fn); return () => subs.delete(fn) },
  openCurrency(id) { subs.forEach(f => { try { f({ type: 'openCurrency', id }) } catch {} }) },
}
