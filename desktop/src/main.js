// PoE2 Dashboard desktop shell.
//
// Architecture (borrowed from Exiled Exchange 2 / awakened-poe-trade):
//   * a tiny local HTTP server serves the built frontend and proxies /api + /callback
//     to whichever backend is active, so the web app runs completely unmodified;
//   * the backend is either the bundled local binary (PyInstaller, data in the user's
//     app-data dir) or a remote server — the split is invisible to the user;
//   * being Chromium, we ARE the browser: the PoE login happens in our own window and
//     the HttpOnly POESESSID is read from our session and handed to the backend.
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell, nativeTheme } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')

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
const DEFAULTS = { mode: 'auto', remoteUrl: 'http://192.168.1.250:8080' }

const settingsPath = () => path.join(app.getPath('userData'), 'desktop-settings.json')
let settings = { ...DEFAULTS }
try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) } } catch {}
const saveSettings = () => { try { fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)) } catch {} }

let win = null
let backendProc = null
let backendUrl = null          // where /api actually lives
let backendKind = 'remote'     // 'local' | 'remote'
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

// TEMPORARY DEV DIAGNOSTIC (see CLAUDE.md "telemetry is mandatory"): report the bundled backend's
// spawn/exit/first-bind on machines we can't touch (Windows). Reuses the sanctioned installlog
// endpoint; posts only backend stdout/stderr (no secrets/keystrokes/clipboard). Strip once the
// 0.2.46 Windows-startup failure is understood and fixed.
function bkLog(m) {
  try {
    fetch('http://192.168.1.250:8080/api/installlog?p=backend', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: `v${app.getVersion()} ${process.platform}: ${m}`,
    }).catch(() => {})
  } catch {}
}

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
             SIDECAR_BIN: sidecarBin, ARBITER_PARENT_PID: String(process.pid) },
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
      // DEV DIAGNOSTIC: report the heavy-analytics pipeline state once, ~90s in (after the sidecar
      // has had time to compute the first discords/arc), so we can see on Windows whether signals
      // are produced or the job is erroring (e.g. numpy/stumpy failing to load).
      setTimeout(async () => {
        try {
          const r = await fetch(`${localUrl}/api/diag`, { signal: AbortSignal.timeout(8000) })
          const d = await r.json()
          bkLog(`analytics ${JSON.stringify(d.analytics || {})}`)
        } catch (e) { bkLog(`analytics-probe-failed ${String(e && e.message || e)}`) }
      }, 90000)
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
    backendUrl = settings.remoteUrl
    backendKind = 'remote-dev'
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
                 '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json' }
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
// Best-effort login diagnostics -> the shazam server, so we can see WHY a login
// (e.g. Steam SSO) fails on a machine we can't touch. Reuses /api/installlog.
function reportLogin(lines) {
  try {
    fetch('http://192.168.1.250:8080/api/installlog?p=login', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: String(Array.isArray(lines) ? lines.join('\n') : lines).slice(0, 20000),
    }).catch(() => {})
  } catch {}
}

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
    backgroundColor: '#0c0d10', webPreferences: { sandbox: true } })
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

function updLog(m) {   // updater telemetry -> server, so we can see why it's silent
  try {
    fetch('http://192.168.1.250:8080/api/installlog?p=update', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: `v${app.getVersion()} ${process.platform} ${m}`,
    }).catch(() => {})
  } catch {}
}

// Unsigned macOS builds can't hot-swap via Squirrel.Mac (it requires a signed+notarized
// app), so quitAndInstall would just quit WITHOUT installing — which read as "the app
// closed and nothing happened". On macOS we therefore skip the in-place flow entirely and
// open the DMG for a manual drag-install; Windows (NSIS) installs in place fine.
// Updates now come from GitHub Releases (electron-updater `github` provider). The Mac
// manual-install flow opens the DMG asset attached to that release's `desktop-v<v>` tag.
const GH_RELEASES = 'https://github.com/Shazambom/shazam-poe2-dashboard/releases/download'
function macDmgUrl(v) { return `${GH_RELEASES}/desktop-v${v}/Arbiter-${v}-arm64.dmg` }

function setupUpdates() {
  if (!app.isPackaged) return
  try {
    const { autoUpdater } = require('electron-updater')
    _autoUpdater = autoUpdater
    autoUpdater.autoDownload = !IS_MAC          // Win: pull in background. Mac: no Squirrel apply, so skip.
    autoUpdater.autoInstallOnAppQuit = !IS_MAC
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
    autoUpdater.on('error', (e) => { updLog(`ERROR ${String(e.message || e)}`); console.log('[updater]', String(e)); _emitUpdate({ phase: 'error', message: String(e.message || e) }) })
    updLog('startup check')
    autoUpdater.checkForUpdates().catch((e) => updLog(`check-threw ${String(e.message || e)}`))
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 30 * 60 * 1000)
  } catch (e) { console.log('[updater] disabled:', String(e)) }
}

ipcMain.handle('update:check', () => { try { _autoUpdater?.checkForUpdates() } catch {} })
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
function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Arbiter',
      submenu: [
        { label: 'Connect PoE trade session…', click: connectPoeSession },
        { label: 'Log out of pathofexile.com', click: async () => {
            await session.defaultSession.clearStorageData({ origin: POE })
            dialog.showMessageBox(win, { message: 'Cleared the pathofexile.com login.' })
          } },
        { type: 'separator' },
        { label: `Backend: ${backendKind === 'local' ? 'local (this machine)' : backendKind}`, enabled: false },
        { type: 'separator' },
        { label: 'Open data folder', click: () => shell.openPath(path.join(app.getPath('userData'), 'data')) },
        { label: 'Check for updates', click: () => { try { require('electron-updater').autoUpdater.checkForUpdates() } catch {} } },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function relaunch() { app.relaunch(); app.exit(0) }

// ------------------------------------------- EE2 integration (presence-driven)
// Self-contained LISTENING layer for Exiled-Exchange-2. NO settings toggle:
// presence IS the switch. The manager self-gates — if EE2 isn't installed it
// stays dormant (and re-checks periodically); if EE2 is present it aligns to
// EE2's own hotkeys via a passive uiohook hook, with a clipboard fallback.
// Best-effort: any failure here is swallowed and the rest of the app is
// unaffected. Local-only (no network) by construction.
let _ee2 = null
async function startEe2Integration() {
  if (_ee2) return
  try {
    const { ExiledExchangeIntegration } = require('./integrations/exiled-exchange')
    const { attachLogDemo } = require('./integrations/exiled-exchange/subscribers/log-demo')
    const { attachEe2Telemetry } = require('./dev-ee2-telemetry')   // DEV diagnostic (see CLAUDE.md)
    _ee2 = new ExiledExchangeIntegration()
    attachLogDemo(_ee2)                       // demo subscriber: logs each hook, no side effects
    attachEe2Telemetry(_ee2, app.getVersion())  // TEMP: report hooks to dev server so we can verify remotely
    await _ee2.start()
  } catch (e) { console.log('[ee2] integration disabled:', String(e)); _ee2 = null }
}
function stopEe2Integration() {
  try { _ee2?.stop() } catch {}
  _ee2 = null
}

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
    backgroundColor: '#191b22',
    autoHideMenuBar: true,   // hide the Dashboard/Edit/View/Window bar by default (Win/Linux); tap Alt to reveal
    webPreferences: {
      contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,   // the Trade tab embeds pathofexile.com/trade2 in a <webview>
    },
  })
  win.loadURL(uiUrl)
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  setupUpdates()
  startEe2Integration()   // self-gates on EE2 presence; dormant if EE2 isn't installed
  try { require('./trade').registerTrade(() => win) } catch (e) { console.log('[trade] register failed:', String(e)) }
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
  const fwd = (url) => { if (isPoeUrl(url)) try { win?.webContents.send('trade:webview-nav', url) } catch {} }
  contents.on('did-navigate', (_ev, url) => fwd(url))
  contents.on('did-navigate-in-page', (_ev, url) => fwd(url))
})

const stopTrade = () => { try { require('./trade').engine.stopAll() } catch {}; try { require('./trade/hotkey.js').unregisterAll() } catch {} }
app.on('window-all-closed', () => { stopTrade(); stopEe2Integration(); stopBackend(); app.quit() })
app.on('before-quit', () => { stopTrade(); stopEe2Integration(); stopBackend() })
