// Which 'trade:webview-nav' events the workspace may act on: only those from the embedded
// <webview> (its webContents id), never the open-trade pop-out or a legacy bare-url payload.
export function shouldAcceptNav(payload, myWcId) {
  if (!payload || typeof payload !== 'object' || myWcId == null) return false
  return payload.wcId === myWcId
}

// A new tab opens the Instant Buyout home (session.js tradeHome, a ?q= URL): the site runs that empty
// search and lands on its slug. That first slug is the page's own, not a search the user ran, so it is
// never saved into the row; every slug after it (the user's searches from the tab) is. Pure.
export const homeCapture = {
  start: (onHome) => ({ skip: !!onHome }),
  next: (state, slug) => (state.skip && slug ? { capture: false, state: { skip: false } } : { capture: !!slug, state }),
}
