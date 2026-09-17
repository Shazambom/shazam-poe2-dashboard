// TEMPORARY DEV DIAGNOSTIC (beta/dev only — every line goes through telemetry.installLog, which is
// gated by diagTelemetryOn). Owner report 2026-09-17: "icons are all text" on the Windows beta, not
// reproducible on the Mac. Currency icons are NOT bundled: the backend learns each icon's path from
// ONE GET of pathofexile.com/api/trade2/data/static at boot, /api/currencies serves those paths, and
// the renderer hotlinks https://web.poecdn.com<path> (Cur.jsx falls back to text when a path is
// missing or the image errors). This reports which link broke:
//   data=   what /api/currencies holds (loaded_at, how many currencies have an icon path)
//   dom=    what the renderer drew (icons loaded / broken / text fallbacks, one sample URL)
//   cdn=    what web.poecdn.com answered for the image requests (status tally, first failure)
// Remove once the cause is known. Reports no user data — counts, status codes and CDN URLs only.
'use strict'

const CDN = 'https://web.poecdn.com/*'

const PROBE = `(() => {
  const imgs = [...document.querySelectorAll('img.cur-img')]
  const broken = imgs.filter(i => i.complete && i.naturalWidth === 0)
  return {
    imgs: imgs.length,
    loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length,
    broken: broken.length,
    text: document.querySelectorAll('.cur-text').length,
    sample: (broken[0] || imgs[0] || {}).src || null,
    online: navigator.onLine,
  }
})()`

function install({ win, session, backendUrl, log }) {
  const cdn = { byStatus: {}, errors: {}, firstBad: null }
  try {
    session.webRequest.onCompleted({ urls: [CDN] }, (d) => {
      cdn.byStatus[d.statusCode] = (cdn.byStatus[d.statusCode] || 0) + 1
      if (d.statusCode >= 400 && !cdn.firstBad) cdn.firstBad = `${d.statusCode} ${d.url.slice(0, 160)}`
    })
    session.webRequest.onErrorOccurred({ urls: [CDN] }, (d) => {
      cdn.errors[d.error] = (cdn.errors[d.error] || 0) + 1
      if (!cdn.firstBad) cdn.firstBad = `${d.error} ${d.url.slice(0, 160)}`
    })
  } catch (e) { log(`hook-failed ${String(e)}`) }

  const report = async (when) => {
    let data = 'unreachable'
    try {
      const d = await (await fetch(`${backendUrl()}/api/currencies`, { signal: AbortSignal.timeout(8000) })).json()
      const list = d.currencies || []
      data = { loaded_at: d.loaded_at ? Math.round(d.loaded_at) : null, n: list.length, withIcon: list.filter(c => c.icon).length }
    } catch (e) { data = `error ${String(e.message || e)}` }
    let dom = 'no-window'
    try { if (win() && !win().isDestroyed()) dom = await win().webContents.executeJavaScript(PROBE, true) } catch (e) { dom = `error ${String(e.message || e)}` }
    log(`${when} data=${JSON.stringify(data)} dom=${JSON.stringify(dom)} cdn=${JSON.stringify(cdn)}`)
  }
  for (const [ms, tag] of [[20000, '@20s'], [120000, '@120s'], [600000, '@10m']]) setTimeout(() => report(tag), ms)
}

module.exports = { install }
