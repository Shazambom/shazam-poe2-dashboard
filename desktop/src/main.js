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
function backendBinary() {
  const name = process.platform === 'win32' ? 'poe2arb-backend.exe' : 'poe2arb-backend'
  const packed = path.join(process.resourcesPath || '', 'backend-bin', name)
  const dev = path.join(__dirname, '..', 'backend-bin', name)
  if (fs.existsSync(packed)) return packed
  if (fs.existsSync(dev)) return dev
  return null
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); if (r.ok) return true } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

async function startBackend() {
  const bin = backendBinary()
  if (settings.mode !== 'remote' && bin) {
    const dataDir = path.join(app.getPath('userData'), 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    backendProc = spawn(bin, [], {
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(LOCAL_BACKEND_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    backendProc.stdout.on('data', d => console.log('[backend]', String(d).trimEnd()))
    backendProc.stderr.on('data', d => console.log('[backend]', String(d).trimEnd()))
    backendProc.on('exit', c => { console.log('[backend] exited', c); backendProc = null })
    if (await waitFor(`http://127.0.0.1:${LOCAL_BACKEND_PORT}/api/status`)) {
      backendUrl = `http://127.0.0.1:${LOCAL_BACKEND_PORT}`
      backendKind = 'local'
      return
    }
    console.log('[backend] local backend failed to come up, falling back to remote')
  }
  backendUrl = settings.remoteUrl
  backendKind = 'remote'
}

function stopBackend() {
  if (backendProc) { try { backendProc.kill() } catch {} backendProc = null }
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
function connectPoeFlow() {
  return new Promise(async (resolve) => {
    const existing = await getPoeCookie()
    if (existing) return resolve(await postSession(existing))
    const login = new BrowserWindow({ width: 1100, height: 800, parent: win, title: 'Log in to Path of Exile' })
    login.loadURL(`${POE}/login`)
    let settled = false
    const poll = setInterval(async () => {
      const cookie = await getPoeCookie()
      if (!cookie || settled) return
      settled = true
      clearInterval(poll)
      login.close()
      resolve(await postSession(cookie))
    }, 1200)
    login.on('closed', () => {
      clearInterval(poll)
      if (!settled) { settled = true; resolve({ ok: false, message: 'Login window closed before signing in.' }) }
    })
  })
}

async function connectPoeSession() {   // menu entry point: adds dialogs
  const r = await connectPoeFlow()
  dialog.showMessageBox(win, { message: r.ok ? `✓ ${r.message}` : `Failed: ${r.message}` })
  if (r.ok) win?.webContents.reload()
}

ipcMain.handle('poe-connect', () => connectPoeFlow())

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
function setupUpdates() {
  if (!app.isPackaged) return
  try {
    const { autoUpdater } = require('electron-updater')
    autoUpdater.autoDownload = process.platform === 'win32'
    autoUpdater.on('update-downloaded', async (info) => {
      const { response } = await dialog.showMessageBox(win, {
        message: `Update ${info.version} ready`, detail: 'Restart to apply?',
        buttons: ['Restart now', 'Later'],
      })
      if (response === 0) autoUpdater.quitAndInstall()
    })
    autoUpdater.on('update-available', async (info) => {
      if (process.platform === 'win32') return   // it downloads itself
      // Unsigned mac builds can't hot-swap; point at the download instead.
      const { response } = await dialog.showMessageBox(win, {
        message: `Update ${info.version} available`, detail: 'Download the new build?',
        buttons: ['Download', 'Later'],
      })
      if (response === 0) shell.openExternal(`${settings.remoteUrl}/downloads/`)
    })
    autoUpdater.on('error', e => console.log('[updater]', String(e)))
    autoUpdater.checkForUpdates().catch(() => {})
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 30 * 60 * 1000)
  } catch (e) { console.log('[updater] disabled:', String(e)) }
}

// ------------------------------------------------------------------- menu
function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Dashboard',
      submenu: [
        { label: 'Connect PoE trade session…', click: connectPoeSession },
        { label: 'Log out of pathofexile.com', click: async () => {
            await session.defaultSession.clearStorageData({ origin: POE })
            dialog.showMessageBox(win, { message: 'Cleared the pathofexile.com login.' })
          } },
        { type: 'separator' },
        { label: `Backend: ${backendKind === 'local' ? 'local (this machine)' : `remote (${settings.remoteUrl})`}`, enabled: false },
        { label: 'Use local backend', type: 'radio', checked: settings.mode !== 'remote', click: () => { settings.mode = 'auto'; saveSettings(); relaunch() } },
        { label: 'Use remote server', type: 'radio', checked: settings.mode === 'remote', click: () => { settings.mode = 'remote'; saveSettings(); relaunch() } },
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

// ------------------------------------------------------------------- boot
app.whenReady().then(async () => {
  nativeTheme.themeSource = 'dark'
  await startBackend()
  await startUiServer()
  buildMenu()
  win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 900, minHeight: 600,
    title: 'PoE2 Dashboard',
    backgroundColor: '#191b22',
    webPreferences: {
      contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,   // the Trade tab embeds pathofexile.com/trade2 in a <webview>
    },
  })
  win.loadURL(uiUrl)
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' } })
  win.webContents.on('did-finish-load', async () => {
    try {
      const ok = await win.webContents.executeJavaScript(
        '[typeof window.poe2desktop?.connectSession, typeof window.poe2desktop?.openTrade].join(",")')
      console.log(`[diag] poe2desktop bridge: connect+openTrade = ${ok}`)   // 'function,function' when live
    } catch (e) { console.log('[diag] bridge check failed:', String(e)) }
  })
  setupUpdates()
})

// The embedded Trade <webview> shares the default session (so it's logged in). Keep
// it on pathofexile.com; anything else (forum links, wiki, etc.) opens externally.
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return
  contents.setWindowOpenHandler(({ url }) => {
    if (isPoeUrl(url)) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (ev, url) => {
    if (!isPoeUrl(url)) { ev.preventDefault(); shell.openExternal(url) }
  })
})

app.on('window-all-closed', () => { stopBackend(); app.quit() })
app.on('before-quit', stopBackend)
