// PoE2 Dashboard desktop shell.
//
// Architecture (borrowed from Exiled Exchange 2 / awakened-poe-trade):
//   * a tiny local HTTP server serves the built frontend and proxies /api + /callback
//     to whichever backend is active, so the web app runs completely unmodified;
//   * the backend is the bundled local binary (PyInstaller, data in the user's app-data
//     dir); only an unpackaged dev launch without a binary points at a dev server;
//   * being Chromium, we ARE the browser: the PoE login happens in our own window and
//     the HttpOnly POESESSID is read from our session and handed to the backend.
const { app, BrowserWindow, Menu, Notification, clipboard, dialog, ipcMain, session, shell, nativeTheme } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')
const telemetry = require('./telemetry.js')

const POE = 'https://www.pathofexile.com'
// One trust-boundary check for "is this a pathofexile.com URL", shared by the
// open-trade handler and the webview navigation guards so they can't diverge.
const isPoeUrl = (url) => /^https:\/\/([a-z0-9-]+\.)*pathofexile\.com\//i.test(String(url))
// Keep the whole login redirect chain in-app: pathofexile.com AND the Steam OpenID
// hosts it bounces through (steamcommunity.com / steampowered.com). Modeled on how
// ExiledExchange2 lets the Steam redirect complete in-window on the shared session.
const isAuthUrl = (url) =>
  isPoeUrl(url) || /^https:\/\/([a-z0-9-]+\.)*(steamcommunity|steampowered)\.com\//i.test(String(url))
const LOCAL_BACKEND_PORT = 8210
const DEFAULTS = { betaChannel: false }
// DEV ONLY: where an unpackaged launch without a bundled binary finds a backend.
const DEV_BACKEND_URL = process.env.ARBITER_DEV_BACKEND_URL || telemetry.SHAZAM
// The two near-black window backdrops (twins of --bg / the trade webview backdrop in styles.css).
const BACKDROP = { window: '#191b22', trade: '#0c0d10' }   // style-ok: painted before the CSS loads

const settingsPath = () => path.join(app.getPath('userData'), 'desktop-settings.json')
let settings = { ...DEFAULTS }
try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) } } catch {}
const saveSettings = () => { try { fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)) } catch {} }

let win = null
let backendProc = null
let backendUrl = null          // where /api actually lives
let backendKind = 'local'      // 'local' | 'dev' (unpackaged launch against a dev server)
let uiUrl = null

// ---------------------------------------------------------------- backend
// Resolve a bundled per-platform binary: the packed location (extraResources) preferred, then the
// dev location. Returns {found, expected} — `found` is the existing path or null; `expected` is the
// packed path to report when nothing is found (a packaging regression). Shared by the backend and
// the analytics sidecar so the resolution rule lives in one place.
function findBundledBin(dir, name) {
  const packed = path.join(process.resourcesPath || '', dir, name)
  const dev = path.join(__dirname, '..', dir, name)
  const found = fs.existsSync(packed) ? packed : (fs.existsSync(dev) ? dev : null)
  return { found, expected: packed }
}

function backendBinary() {
  const name = process.platform === 'win32' ? 'poe2arb-backend.exe' : 'poe2arb-backend'
  return findBundledBin('backend-bin', name).found
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.ok) return true } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

// Are we on the beta (dev) channel? Beta builds carry a `-beta.N` prerelease tag AND the user opted
// in via Settings. ALL diagnostics telemetry is GATED on this (owner directive 2026-09-16): live on
// beta / in dev, silent in a stable packaged build — including the updater's own lines. There is
// one sender (telemetry.installLog) and this is its one gate.
const isBetaVersion = () => /-beta\./.test(app.getVersion())
const onBetaChannel = () => !!settings.betaChannel || isBetaVersion()
const diagTelemetryOn = () => !app.isPackaged || onBetaChannel()
telemetry.configure({ enabled: diagTelemetryOn, version: () => app.getVersion() })

// Beta-only diagnostics: the bundled backend's spawn/exit/first-bind on machines we can't touch
// (Windows). Posts only backend stdout/stderr (no secrets/keystrokes/clipboard).
const bkLog = (m) => telemetry.installLog('backend', m)

// The desktop app is FULLY SELF-CONTAINED: it runs its own bundled backend + local
// DB and NEVER calls the server for data. The ONLY permitted outbound calls are the
// auto-updater (electron-updater → GitHub Releases) and update telemetry (installlog).
// See DESKTOP_CONTRACT in the docs.
async function startBackend() {
  const localUrl = `http://127.0.0.1:${LOCAL_BACKEND_PORT}`
  const bin = backendBinary()
  if (bin) {
    const dataDir = path.join(app.getPath('userData'), 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    // Bundled market snapshot (extraResources). The backend seeds market.sqlite from it
    // on first run / when newer, so users skip the cold backfill. Build-time only — the
    // desktop contract (server only for updates) is unaffected. Missing in dev = crawl live.
    // Seed ships gzipped (~8x smaller); the backend decompresses it once. Fall back to a
    // plain .sqlite if present (dev convenience).
    const seedDirs = [path.join(process.resourcesPath || '', 'market-seed'),
                      path.join(__dirname, '..', 'market-seed')]
    const seedNames = ['market-seed.sqlite.gz', 'market-seed.sqlite']
    let marketSeed = ''
    for (const d of seedDirs) { for (const n of seedNames) {
      const p = path.join(d, n); if (fs.existsSync(p)) { marketSeed = p; break }
    } if (marketSeed) break }
    if (marketSeed) console.log('[backend] market seed:', marketSeed)
    // Sidecar binary (heavy analytics), bundled per-platform via extraResources like the
    // backend. The backend spawns + supervises it; SIDECAR_BIN tells it where. Absent in dev =
    // backend runs the sidecar from source (or skips it). See docs/db-architecture.md.
    const sidecarName = process.platform === 'win32' ? 'poe2arb-sidecar.exe' : 'poe2arb-sidecar'
    const sc = findBundledBin('sidecar-bin', sidecarName)
    // Pass the EXPECTED path even when not found, so the backend supervisor can log a warning
    // (packaging regression) instead of silently disabling analytics.
    const sidecarBin = sc.found || sc.expected
    console.log('[backend] sidecar bin:', sidecarBin, sc.found ? '' : '(expected; not found)')
    backendProc = spawn(bin, [], {
      // ARBITER_PARENT_PID lets the backend die with us if Electron hard-crashes (parent-pid
      // watchdog); the web/server env never sets it, so servers are unaffected.
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(LOCAL_BACKEND_PORT), MARKET_SEED: marketSeed,
             SIDECAR_BIN: sidecarBin, ARBITER_PARENT_PID: String(process.pid),
             ARBITER_VERSION: app.getVersion(),
             // Diagnostics telemetry (backend + sidecar) fires only on the beta/dev channel.
             ARBITER_TELEMETRY: diagTelemetryOn() ? '1' : '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // DEV DIAGNOSTIC: keep a rolling tail of backend output so a crash/hang on Windows is visible.
    let bkBuf = ''
    const capture = (d) => { bkBuf = (bkBuf + String(d)).slice(-6000); console.log('[backend]', String(d).trimEnd()) }
    backendProc.stdout.on('data', capture)
    backendProc.stderr.on('data', capture)
    backendProc.on('error', e => bkLog(`proc-error ${String(e && e.message || e)}`))
    backendProc.on('exit', (code, signal) => {
      console.log('[backend] exited', code, signal)
      bkLog(`EXITED code=${code} signal=${signal}\n--- output tail ---\n${bkBuf.slice(-3000)}`)
      backendProc = null
    })
    const t0 = Date.now()
    if (await waitFor(`${localUrl}/api/status`, 240)) {   // ~2min: cover a slow first-boot re-seed before declaring failure
      bkLog(`bound after ${Math.round((Date.now() - t0) / 1000)}s`)
      // DEV DIAGNOSTIC: probe the heavy-analytics pipeline REPEATEDLY (not one blind snapshot) so we
      // see job progression on Windows — whether the 'done' bucket ever appears, or jobs stay wedged
      // at 'running'. Combined with the sidecar's own p=sidecar telemetry this pinpoints where it dies.
      for (const delay of [60000, 150000, 300000]) {
        setTimeout(async () => {
          try {
            const r = await fetch(`${localUrl}/api/diag`, { signal: AbortSignal.timeout(8000) })
            const d = await r.json()
            bkLog(`analytics@${Math.round(delay / 1000)}s ${JSON.stringify(d.analytics || {})}`)
          } catch (e) { bkLog(`analytics-probe-failed ${String(e && e.message || e)}`) }
        }, delay)
      }
      backendUrl = localUrl
      backendKind = 'local'
      return
    }
    // Never bound within the wait window: report whether it's still alive (hung) or gone (crashed),
    // with the output tail showing where it stalled — this is the data we were missing.
    bkLog(`NOT-BOUND after ${Math.round((Date.now() - t0) / 1000)}s proc=${backendProc ? 'alive' : 'exited'} bin=${bin}\n--- output tail ---\n${bkBuf.slice(-3000)}`)
    console.log('[backend] bundled backend failed to come up')
  } else if (!app.isPackaged) {
    // DEV ONLY (never a shipped build): no bundled binary present, so point at the
    // dev server for convenience. Packaged apps must never reach here.
    backendUrl = DEV_BACKEND_URL
    backendKind = 'dev'
    return
  }
  // Shipped app stays local even if the backend is down — we never fall back to the
  // server. Requests will fail visibly rather than silently phone home.
  backendUrl = localUrl
  backendKind = 'local'
}

function stopBackend() {
  if (!backendProc) return
  const pid = backendProc.pid
  // Kill the whole backend tree. On Windows a plain .kill() can leave the child
  // running, which then locks the install dir and breaks the next update — so force
  // the tree down with taskkill /T /F.
  try {
    if (process.platform === 'win32' && pid) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      backendProc.kill()
    }
  } catch {}
  backendProc = null
}

// ------------------------------------------------------- local UI server
function startUiServer() {
  const dist = fs.existsSync(path.join(__dirname, '..', 'app-dist'))
    ? path.join(__dirname, '..', 'app-dist')
    : path.join(__dirname, '..', '..', 'frontend', 'dist')
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
                 '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
                 '.m4a': 'audio/mp4' }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname.startsWith('/api/') || u.pathname === '/callback') {
      const target = new URL(backendUrl)
      const opts = {
        hostname: target.hostname, port: target.port || 80,
        path: u.pathname + u.search, method: req.method,
        headers: { ...req.headers, host: target.host },
      }
      const p = http.request(opts, r => {
        res.writeHead(r.statusCode, r.headers)
        r.pipe(res)                       // streams SSE chunk-by-chunk
      })
      p.on('error', e => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ detail: `backend unreachable: ${e.message}` })) })
      req.pipe(p)
      return
    }
    let f = path.join(dist, u.pathname === '/' ? 'index.html' : u.pathname)
    if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, 'index.html')
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
    fs.createReadStream(f).pipe(res)
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      uiUrl = `http://127.0.0.1:${server.address().port}`
      console.log(`[ui] serving ${dist} at ${uiUrl} -> backend ${backendUrl} (${backendKind})`)
      resolve()
    })
  })
}

// ------------------------------------------------------------ PoE session
async function getPoeCookie() {
  const cs = await session.defaultSession.cookies.get({ url: POE, name: 'POESESSID' })
  return cs.length && cs[0].value ? cs[0].value : null
}

async function postSession(cookie) {
  try {
    const r = await fetch(`${backendUrl}/api/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie, label: `desktop app (${backendKind})` }),
    })
    const body = await r.json().catch(() => ({}))
    return { ok: r.ok, message: body.message || body.detail || `HTTP ${r.status}` }
  } catch (e) { return { ok: false, message: String(e.message || e) } }
}

// Full connect flow as a promise: use the existing login cookie if present,
// otherwise open a login window and finish as soon as the cookie appears.
// Resolves with the backend's verdict so callers (menu OR the in-page button
// via IPC) can show it however they like.
// Beta-only login diagnostics, so we can see WHY a login (e.g. Steam SSO) fails on a machine we
// can't touch: the login window's navigation chain + console (never the cookie).
const reportLogin = (lines) => telemetry.installLog('login', lines, { max: 20000 })

function connectPoeFlow() {
  return new Promise(async (resolve) => {
    const existing = await getPoeCookie()
    if (existing) return resolve(await postSession(existing))
    const login = new BrowserWindow({ width: 1100, height: 800, parent: win, title: 'Log in to Path of Exile' })
    const buf = [`ua=${login.webContents.getUserAgent()}`]
    const wc = login.webContents
    // Keep the GGG/Steam login redirect chain inside the app (child popups inherit
    // this window's session, so cookies still land in defaultSession); only send
    // genuinely-external links out. This is what stops Steam opening in Firefox.
    wc.setWindowOpenHandler(({ url }) => {
      log(`popup ${url}`)
      if (isAuthUrl(url)) return { action: 'allow' }
      shell.openExternal(url); return { action: 'deny' }
    })
    const log = (m) => { const t = new Date().toISOString().slice(11, 19); buf.push(`${t} ${m}`) }
    wc.on('did-start-navigation', (_e, u, inPage, isMain) => { if (isMain) log(`nav-start ${u}`) })
    wc.on('did-redirect-navigation', (_e, u) => log(`redirect ${u}`))
    wc.on('did-navigate', (_e, u) => log(`navigated ${u}`))
    wc.on('did-navigate-in-page', (_e, u, isMain) => { if (isMain) log(`in-page ${u}`) })
    wc.on('did-fail-load', (_e, code, desc, u) => log(`FAIL-LOAD ${code} ${desc} ${u}`))
    wc.on('console-message', (_e, level, message) => log(`console[${level}] ${String(message).slice(0, 300)}`))
    login.loadURL(`${POE}/login`)
    let settled = false
    const finish = (result) => { if (!settled) { settled = true; reportLogin(buf); resolve(result) } }
    const poll = setInterval(async () => {
      const cookie = await getPoeCookie()
      if (!cookie || settled) return
      clearInterval(poll)
      log('cookie acquired -> posting to backend')
      login.close()
      finish(await postSession(cookie))
    }, 1200)
    login.on('closed', () => {
      clearInterval(poll)
      log('login window closed')
      finish({ ok: false, message: 'Login window closed before signing in.' })
    })
  })
}

async function connectPoeSession() {   // menu entry point: adds dialogs
  const r = await connectPoeFlow()
  dialog.showMessageBox(win, { message: r.ok ? `✓ ${r.message}` : `Failed: ${r.message}` })
  if (r.ok) win?.webContents.reload()
}

ipcMain.handle('app-version', () => app.getVersion())

// OS notifications from the MAIN process: on macOS a renderer (HTML5) Notification carries no app
// identity and is easy for the system to suppress; a main-process one shows as "Arbiter" in
// Notification Center (and triggers the one-time allow prompt), and a click raises the window.
// The renderer picks the family/channel rules (lib/notifications.js); this only delivers.
ipcMain.handle('notify', (_e, { title, body, tag } = {}) => {
  if (!Notification.isSupported()) { console.log('[notify] not supported on this OS'); return false }
  try {
    const n = new Notification({ title: String(title || 'Arbiter'), body: String(body || ''), silent: true })
    n.on('click', () => { try { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); win.webContents.send('notify:click', tag) } } catch {} })
    n.on('show', () => console.log('[notify] shown:', title))
    n.on('failed', (_ev, err) => console.log('[notify] failed:', err))
    n.show()
    return true
  } catch (e) { console.log('[notify] error:', String(e)); return false }
})

ipcMain.handle('open-login', () => shell.openExternal(`${POE}/login`))

ipcMain.handle('poe-connect', async () => {
  const r = await connectPoeFlow()
  if (r.ok) reloadTradeWebviews()   // native login lands in defaultSession; refresh an open Trade tab
  return r
})

// Reload every embedded Trade <webview> so it picks up a freshly-connected session.
function reloadTradeWebviews() {
  try {
    require('electron').webContents.getAllWebContents()
      .filter(c => c.getType() === 'webview')
      .forEach(c => { try { c.reload() } catch {} })
  } catch {}
}

// A pasted POESESSID reaches only the backend; mirror it into the Electron session
// so the embedded Trade site (which uses defaultSession) is logged in too.
ipcMain.handle('poe-set-cookie', async (_e, cookie) => {
  if (!cookie) return { ok: false, message: 'empty cookie' }
  try {
    await session.defaultSession.cookies.set({
      url: POE, name: 'POESESSID', value: String(cookie).trim(),
      domain: '.pathofexile.com', path: '/', secure: true, httpOnly: true,
      sameSite: 'lax', expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    })
    reloadTradeWebviews()
    return { ok: true }
  } catch (e) { return { ok: false, message: String(e.message || e) } }
})

// Open a trade-site search in its own window, sharing the app's PoE session so
// you're already logged in and GGG's live search just works. Human-driven only.
ipcMain.handle('open-trade', (_e, url) => {
  if (!isPoeUrl(url)) return false
  const w = new BrowserWindow({ width: 1280, height: 900, title: 'Path of Exile — Trade',
    backgroundColor: BACKDROP.trade, webPreferences: { sandbox: true, zoomFactor: 1 } })
  w.loadURL(url)
  return true
})

// ---------------------------------------------------------------- updates
// Renderer-driven, seamless: auto-download in the background with progress, then the
// in-app Update button installs in place (quitAndInstall) — no download page, no
// manual binary. Fully in-place on Windows; unsigned macOS can't hot-swap (Squirrel
// requires a signed+notarized app), so mac reports the state but the swap needs a
// Developer ID cert — drop `identity: null` in package.json once one exists.
let _autoUpdater = null
let _latestVersion = null
const IS_MAC = process.platform === 'darwin'

function _emitUpdate(state) {
  try { win?.webContents.send('update:status', state) } catch {}
}

const updLog = (m) => telemetry.installLog('update', m)   // updater diagnostics (beta/dev only, like all telemetry)

// Unsigned macOS builds can't hot-swap via Squirrel.Mac (it requires a signed+notarized
// app), so quitAndInstall would just quit WITHOUT installing — which read as "the app
// closed and nothing happened". On macOS we therefore skip the in-place flow entirely and
// open the DMG for a manual drag-install; Windows (NSIS) installs in place fine.
// Updates now come from GitHub Releases (electron-updater `github` provider). The Mac
// manual-install flow opens the DMG asset attached to that release's `desktop-v<v>` tag.
const GH_RELEASES = 'https://github.com/Shazambom/shazam-poe2-dashboard/releases/download'
// Stable releases are tagged `desktop-v<ver>`; beta releases use the bare semver `<ver>` tag (so
// electron-updater's prerelease channel path can parse it — the desktop-v prefix fails semver.valid).
function relTag(v) { return /-beta\./.test(v) ? v : `desktop-v${v}` }
function macDmgUrl(v) { return `${GH_RELEASES}/${relTag(v)}/Arbiter-${v}-arm64.dmg` }

function _applyChannel(au) {
  const beta = onBetaChannel()
  try {
    au.allowPrerelease = beta
    au.channel = beta ? 'beta' : 'latest'
  } catch {}
  return beta
}

function setupUpdates() {
  if (!app.isPackaged) return
  try {
    const { autoUpdater } = require('electron-updater')
    _autoUpdater = autoUpdater
    autoUpdater.autoDownload = !IS_MAC          // Win: pull in background. Mac: no Squirrel apply, so skip.
    autoUpdater.autoInstallOnAppQuit = !IS_MAC
    // Channel: stable reads latest.yml; beta (dev) reads beta.yml + accepts GitHub pre-releases. The
    // beta releases are `x.y.z-beta.N` prereleases so stable users (allowPrerelease=false) never see them.
    _applyChannel(autoUpdater)
    autoUpdater.on('checking-for-update', () => { updLog('checking'); _emitUpdate({ phase: 'checking' }) })
    autoUpdater.on('update-not-available', (info) => { updLog(`not-available (latest=${info?.version})`); _emitUpdate({ phase: 'none' }) })
    autoUpdater.on('update-available', (info) => {
      _latestVersion = info?.version
      updLog(`available ${info?.version}`)
      // Mac: offer a manual DMG install immediately (no background download). Win: downloading.
      _emitUpdate(IS_MAC ? { phase: 'manual', version: info?.version } : { phase: 'downloading', version: info?.version, percent: 0 })
    })
    autoUpdater.on('download-progress', (p) => _emitUpdate({ phase: 'downloading', percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info) => { _latestVersion = info?.version; updLog(`downloaded ${info?.version}`); _emitUpdate({ phase: 'ready', version: info?.version }) })
    autoUpdater.on('error', (e) => {
      const msg = String(e?.message || e)
      updLog(`ERROR ${msg}`); console.log('[updater]', String(e))
      // An empty channel is not a failure: on the beta channel before the first beta is published,
      // GitHub has no beta.yml → "No published versions" / 404. Treat as "up to date", not an error,
      // so opting into beta never shows a scary error when the channel is simply empty.
      const benign = /No published versions|404|Cannot find (channel|latest)|ENOTFOUND|net::/i.test(msg)
      _emitUpdate(benign ? { phase: 'none' } : { phase: 'error', message: msg })
    })
    updLog('startup check')
    autoUpdater.checkForUpdates().catch((e) => updLog(`check-threw ${String(e.message || e)}`))
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 30 * 60 * 1000)
  } catch (e) { console.log('[updater] disabled:', String(e)) }
}

ipcMain.handle('update:check', () => { try { _autoUpdater?.checkForUpdates() } catch {} })
// Beta/dev channel opt-in (persisted). `locked` = the running build is itself a -beta build, so the
// toggle can't be turned off from here (you'd need to reinstall a stable build); we surface that.
ipcMain.handle('update:getChannel', () => ({ beta: onBetaChannel(), locked: isBetaVersion() }))
ipcMain.handle('update:setChannel', (_e, beta) => {
  settings.betaChannel = !!beta
  saveSettings()
  if (_autoUpdater) { _applyChannel(_autoUpdater); _autoUpdater.checkForUpdates().catch(() => {}) }
  return { beta: onBetaChannel(), locked: isBetaVersion() }
})
ipcMain.handle('update:install', () => {
  if (IS_MAC) {
    // Can't hot-swap unsigned — open the DMG in the browser for a manual install; keep the
    // app running so the user isn't left staring at a closed window.
    const url = macDmgUrl(_latestVersion || app.getVersion())
    try { require('electron').shell.openExternal(url) } catch (e) { _emitUpdate({ phase: 'error', message: String(e) }) }
    updLog(`mac-manual-open ${url}`)
    _emitUpdate({ phase: 'manual', version: _latestVersion })
    return
  }
  // Windows: kill the bundled backend FIRST so it doesn't lock the install dir during the
  // update (that left users with a dead/removed app), then SILENT install + relaunch.
  // Silent (isSilent=true) matters: the NSIS self-heal skips its destructive cleanup when
  // silent, so the auto-update no longer nukes the install dir it's upgrading.
  updLog('install-clicked (win silent quitAndInstall)')
  try { stopBackend() } catch {}
  setTimeout(() => {
    try { _autoUpdater?.quitAndInstall(true, true) } catch (e) { updLog(`quitAndInstall-threw ${String(e)}`); _emitUpdate({ phase: 'error', message: String(e) }) }
  }, 400)
})

// ------------------------------------------------------------------- menu
// Zoom is pinned to 1 everywhere (menu.js explains the bug); this resets any guest that drifted.
function resetTradeZoom() {
  try {
    require('electron').webContents.getAllWebContents().forEach(c => { try { c.setZoomLevel(0); c.setZoomFactor(1) } catch {} })
  } catch {}
}

function buildMenu() {
  const arbiter = [
    { label: 'Connect PoE trade session…', click: connectPoeSession },
    { label: 'Log out of pathofexile.com', click: async () => {
        await session.defaultSession.clearStorageData({ origin: POE })
        dialog.showMessageBox(win, { message: 'Cleared the pathofexile.com login.' })
      } },
    { type: 'separator' },
    { label: `Backend: ${backendKind === 'local' ? 'local (this machine)' : 'dev server'}`, enabled: false },
    { type: 'separator' },
    { label: 'Open data folder', click: () => shell.openPath(path.join(app.getPath('userData'), 'data')) },
    { label: 'Check for updates', click: () => { try { _autoUpdater?.checkForUpdates() } catch {} } },
  ]
  const { buildMenuTemplate } = require('./menu.js')
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({ arbiter, resetTradeZoom })))
}

// ------------------------------------------- EE2 integration (presence-driven)
// Self-contained LISTENING layer for Exiled-Exchange-2. NO settings toggle:
// presence IS the switch. The manager self-gates — if EE2 isn't installed it
// stays dormant (and re-checks periodically); if EE2 is present it aligns to
// EE2's own hotkeys via a passive uiohook hook, with a clipboard fallback.
// Best-effort: any failure here is swallowed and the rest of the app is
// unaffected. Local-only (no network) by construction.
let _ee2 = null
let _history = null          // the ExiledExchange2 History consumer (ee2-history/index.js)
let _unwatchEe2Config = null
async function startEe2Integration() {
  if (_ee2) return
  try {
    const { ExiledExchangeIntegration } = require('./integrations/exiled-exchange')
    const { attachLogDemo } = require('./integrations/exiled-exchange/subscribers/log-demo')
    const { attachEe2Telemetry } = require('./dev-ee2-telemetry')   // DEV diagnostic (see CLAUDE.md)
    _ee2 = new ExiledExchangeIntegration()
    attachLogDemo(_ee2)                       // demo subscriber: logs each hook, no side effects
    attachEe2Telemetry(_ee2)  // TEMP: report hooks to dev server so we can verify remotely
    // The actions layer (roadmap §9): every item-checked → worker → one IngestIntent to the renderer.
    // The package is untouched; this attaches beside it. Telemetry goes through the one gated sender.
    try {
      const { createHistoryConsumer } = require('./ee2-history')
      const { spawnWorker } = require('./ee2-history/worker-host.js')
      const { readPrefs } = require('./ee2-history/prefs.js')
      _history = createHistoryConsumer({
        manager: _ee2, worker: { spawn: spawnWorker }, prefs: readPrefs,
        send: win && !win.isDestroyed() && !win.webContents.isLoading() ? (ch, p) => { try { win.webContents.send(ch, p) } catch {} } : null,
        log: (line) => telemetry.installLog('ee2', line),
        hint: (policy) => { try { require('./trade/budget.js').hint(policy) } catch {} },   // 4-B shared GGG budget
      })
      try { _unwatchEe2Config = require('./integrations/exiled-exchange/ee2-config.js').watchConfig(() => _history?.invalidatePrefs()) } catch {}
    } catch (e) { console.log('[ee2-history] disabled:', String(e)); _history = null }
    await _ee2.start()
  } catch (e) { console.log('[ee2] integration disabled:', String(e)); _ee2 = null }
}
function stopEe2Integration() {
  try { _unwatchEe2Config?.() } catch {}; _unwatchEe2Config = null
  try { _history?.stop() } catch {}; _history = null
  try { _ee2?.stop() } catch {}
  _ee2 = null
}

// Renderer ↔ history consumer (batch 3). The renderer owns the setting; main only skips builds.
ipcMain.on('ee2:set-enabled', (_e, p) => { _history?.setEnabled(p?.enabled !== false) })
ipcMain.handle('ee2:status', () => (_history ? _history.status() : { present: false, running: false, configRead: false, leagueId: null, warm: false, enabled: true }))
ipcMain.on('trade:ingest-ack', (_e, ack) => { if (ack && ack.result === 'dropped') telemetry.installLog('ee2', `ingest-drop reason=${ack.reason || '?'}`) })
// DEV ONLY: feed a fixture item through the real consumer + worker without EE2 running (CDP drives).
ipcMain.handle('dev:ee2-item', (_e, item) => {
  if (app.isPackaged || !_history) return false
  _history.onItem({ name: '', baseType: '', rarity: '', itemClass: '', origin: 'clipboard', ts: Date.now(), ...(item || {}) })
  return true
})

// ------------------------------------------------------------------- boot
// Single-instance lock: a second launch (or the installer relaunching us) hands
// focus to the existing window instead of spawning a duplicate process. Without
// this, a lingering copy can block the NSIS installer ("cannot be closed").
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus() }
  })
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'
  await startBackend()
  await startUiServer()
  buildMenu()
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 900, minHeight: 600,
    title: 'Arbiter',
    backgroundColor: BACKDROP.window,
    autoHideMenuBar: true,   // hide the Dashboard/Edit/View/Window bar by default (Win/Linux); tap Alt to reveal
    webPreferences: {
      contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,   // the Trade tab embeds pathofexile.com/trade2 in a <webview>
      zoomFactor: 1,      // never inherit a persisted per-origin zoom (see menu.js)
    },
  })
  win.loadURL(uiUrl)
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('did-finish-load', () => { _history?.setSender((ch, p) => { try { win?.webContents.send(ch, p) } catch {} }) })
  win.on('closed', () => { _history?.setSender(null) })
  setupUpdates()
  startEe2Integration()   // self-gates on EE2 presence; dormant if EE2 isn't installed
  try { require('./trade').registerTrade(() => win, () => backendUrl) } catch (e) { console.log('[trade] register failed:', String(e)) }
  try {
    const { registerHotkey } = require('./trade/hotkey.js')
    const combo = settings.focusHotkey || 'CommandOrControl+G'
    const r = registerHotkey(() => win, combo)
    if (!r.ok) console.log('[hotkey] combo unavailable:', combo)
    ipcMain.handle('hotkey:get', () => ({ combo: settings.focusHotkey || 'CommandOrControl+G' }))
    ipcMain.handle('hotkey:set', (_e, combo) => {
      const res = registerHotkey(() => win, combo)
      if (res.ok) { settings.focusHotkey = combo; saveSettings() }
      return res
    })
  } catch (e) { console.log('[hotkey] register failed:', String(e)) }
})

// The embedded Trade <webview> shares the default session (so it's logged in). Keep
// pathofexile.com AND the Steam login hosts in-app (so Steam sign-in works from the
// Trade tab too); anything else (forum links, wiki, etc.) opens externally.
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return
  // Pin the guest's zoom: Chromium persists zoom per origin on the shared session and syncs the
  // guest to the embedder on navigation, which is how a stray ⌘+ used to stick across restarts.
  try { contents.setZoomFactor(1); contents.setVisualZoomLevelLimits(1, 1) } catch {}
  contents.setWindowOpenHandler(({ url }) => {
    if (isAuthUrl(url)) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (ev, url) => {
    if (!isAuthUrl(url)) { ev.preventDefault(); shell.openExternal(url) }
  })
  // The trade SPA updates the URL without firing <webview> DOM events, but the guest
  // webContents DOES fire did-navigate/did-navigate-in-page. Forward those to the renderer
  // so the workspace can capture a run search into the active entry (event-driven, no poll).
  // The payload names the guest (wcId) so the renderer can ignore the open-trade pop-out, and
  // the loading phases drive the workspace's progress hairline.
  const fwd = (url, phase) => { if (isPoeUrl(url)) try { win?.webContents.send('trade:webview-nav', { url, wcId: contents.id, phase }) } catch {} }
  contents.on('did-navigate', (_ev, url) => { try { contents.setZoomLevel(0) } catch {}; fwd(url, 'nav') })
  contents.on('did-navigate-in-page', (_ev, url) => fwd(url, 'nav'))
  contents.on('did-start-loading', () => fwd(contents.getURL(), 'start'))
  contents.on('did-stop-loading', () => fwd(contents.getURL(), 'stop'))
})

// ---------------------------------------------------- renderer bridges (batch 1)
// Diagnostics: the renderer's one narrow path to installLog (allow-list, clamp, budget — see
// diag-bridge.js); the gate stays telemetry.configure's diagTelemetryOn().
const diagLog = require('./diag-bridge.js').makeDiagBridge({ installLog: telemetry.installLog })
ipcMain.handle('diag:log', (_e, p) => diagLog(p?.marker, p?.line))
// Clipboard-add: MAIN reads and classifies; only the classification crosses (never the text).
ipcMain.handle('clipboard:classify', async () => {
  const { classifyClipboard, MAX_CLIP } = require('./clipboard-add.js')
  const cls = classifyClipboard(() => clipboard.readText())
  if (cls.kind !== 'item') return cls
  // 4-A: the item rung — the history consumer's worker builds the query here; the text stays in main.
  if (!_history) return { kind: 'none', len: 0 }
  const intent = await _history.buildIntent(String(clipboard.readText() || '').slice(0, MAX_CLIP), 'clipboard')
  return intent ? { kind: 'item', intent } : { kind: 'none', len: 0, currency: true }
})

// Give the renderer a beat to flush its debounced workspace save before we go: send ws:flush,
// wait for ws:flushed (or 1 s), then quit for real.
let _flushedForQuit = false
app.on('before-quit', (e) => {
  if (_flushedForQuit || !win || win.isDestroyed()) return
  e.preventDefault()
  const done = () => { if (_flushedForQuit) return; _flushedForQuit = true; app.quit() }
  ipcMain.once('ws:flushed', done)
  setTimeout(done, 1000)
  try { win.webContents.send('ws:flush') } catch { done() }
})

const stopTrade = () => { try { require('./trade').engine.stopAll() } catch {}; try { require('./trade/hotkey.js').unregisterAll() } catch {} }
app.on('window-all-closed', () => { stopTrade(); stopEe2Integration(); stopBackend(); app.quit() })
app.on('before-quit', () => { stopTrade(); stopEe2Integration(); stopBackend() })
