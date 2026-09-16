// Which 'trade:webview-nav' events the workspace may act on: only those from the embedded
// <webview> (its webContents id), never the open-trade pop-out or a legacy bare-url payload.
export function shouldAcceptNav(payload, myWcId) {
  if (!payload || typeof payload !== 'object' || myWcId == null) return false
  return payload.wcId === myWcId
}
