// PoE2 trade API access from the Electron MAIN process. This is the ONLY path that can
// reach pathofexile.com's Cloudflare-gated internal trade API: net.request on the
// defaultSession sends both POESESSID and cf_clearance (from the in-app login) with the
// matching User-Agent. The backend (bare POESESSID) would be 403'd. Pattern from
// Exiled-Exchange-2's main/src/proxy.ts. Contract-clean: it's the user's own session
// hitting pathofexile.com, never our server.
const { app, net, session } = require('electron')

const POE = 'https://www.pathofexile.com'

let _cfHookInstalled = false
// Cloudflare marks cf_clearance `Partitioned`; net.request won't persist a partitioned
// cookie back into the jar, so strip the attribute on the way in (EE2's exact fix).
function installCloudflareCookieFix() {
  if (_cfHookInstalled) return
  _cfHookInstalled = true
  try {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      const h = details.responseHeaders || {}
      const key = Object.keys(h).find(k => k.toLowerCase() === 'set-cookie')
      if (key && Array.isArray(h[key])) h[key] = h[key].map(c => c.replace(/;\s*Partitioned/ig, ''))
      cb({ responseHeaders: h })
    })
  } catch (e) { console.log('[trade] cf cookie hook failed:', String(e)) }
}

function userAgent() {
  // The UA cf_clearance is bound to. app.userAgentFallback is the app-wide default all
  // sessions use unless overridden, i.e. what the login window presented.
  return app.userAgentFallback || session.defaultSession.getUserAgent?.() || ''
}

async function cookieHeader() {
  const cs = await session.defaultSession.cookies.get({ url: POE })
  return cs.filter(c => c.value).map(c => `${c.name}=${c.value}`).join('; ')
}

// Perform a trade-API request through the user's session. Returns { status, headers, body }.
// `path` is an absolute path like "/api/trade2/search/poe2/Standard".
function poeRequest({ method = 'GET', path, body = null, referer = null }) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method, url: POE + path, session: session.defaultSession, useSessionCookies: true })
    request.setHeader('User-Agent', userAgent())
    request.setHeader('Accept', 'application/json')
    request.setHeader('Origin', POE)
    request.setHeader('Referer', referer || `${POE}/trade2`)
    request.setHeader('X-Requested-With', 'XMLHttpRequest')   // omitting -> 403 code 6 on whisper
    if (body != null) request.setHeader('Content-Type', 'application/json')
    let data = ''
    request.on('response', (res) => {
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
      res.on('error', reject)
    })
    request.on('error', reject)
    if (body != null) request.write(JSON.stringify(body))
    request.end()
  })
}

function poeJson(resp) {
  try { return JSON.parse(resp.body) } catch { return null }
}

module.exports = { POE, installCloudflareCookieFix, poeRequest, poeJson, cookieHeader, userAgent }
