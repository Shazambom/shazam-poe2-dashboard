// "Report a problem": package the app's state, logs and a picture of every screen into ONE sealed
// file on disk, and hand it to the user to drag into the Discord #bug-reports forum. There is no
// drop point — the app makes no new outbound call (the invite opens in the OS browser), holds no
// credential, and nothing here can bill anyone. See docs/feedback-implementation-plan.md.
//
// Three IPC handlers, all rejecting any sender but the app window:
//   feedback:package → throttle → sweep screens → bundle → seal → <userData>/reports/arbiter-report-<ID>.arb
//   feedback:drag    → native drag of that file out of the window (into the Discord post)
//   feedback:reveal  → show the file in Finder/Explorer;  feedback:discord → open the invite
'use strict'
const fs = require('fs')
const path = require('path')
const { randomBytes, randomUUID } = require('crypto')
const os = require('os')
const { DESTS } = require('./dests.js')
const { installId } = require('./installid.js')

// The invite targets the #bug-reports forum channel. PLACEHOLDER until the owner creates the
// server (docs/dev-notes.md → Feedback reports) — replace before the feature ships.
const DISCORD_INVITE = 'https://discord.gg/arbiter-bug-reports-PLACEHOLDER'
const KEEP_REPORTS = 10
const THROTTLE_MS = 60_000
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'   // no I, L, O, U: reads aloud without ambiguity
const shortId = () => Array.from(randomBytes(6), b => CROCKFORD[b % 32]).join('')
const ID_RE = /^[0-9A-HJ-NP-Z]{6}$/

function registerFeedback({ ipcMain, BrowserWindow, session, win, uiUrl, backendUrl, userData, version, channel, theme, sources,
                            shell, icon, sweep, bundle, sealFn, get, now = Date.now }) {
  const dir = path.join(userData, 'reports')
  const produced = new Map()       // shortId → file, this session only: the only files drag/reveal may touch
  let last = null                  // { at, shortId, file } — the throttle
  const fromApp = (e) => e && e.sender && win && !win.isDestroyed?.() && e.sender.id === win.webContents.id
  const fileOf = (p) => { const id = String(p && p.shortId || ''); return ID_RE.test(id) ? produced.get(id) : undefined }

  const fetchJson = get || (async (p) => {
    const r = await fetch(`${backendUrl}${p}`, { signal: AbortSignal.timeout(4000) })
    return r.json()
  })
  const readDesktopSettings = () => { try { return JSON.parse(fs.readFileSync(path.join(userData, 'desktop-settings.json'), 'utf8')) } catch { return {} } }
  const rendererErrors = async () => { try { return await win.webContents.executeJavaScript('window.__arbiterErrors ? window.__arbiterErrors() : []') } catch { return [] } }
  const prune = () => {
    try {
      const files = fs.readdirSync(dir).filter(f => /^arbiter-report-[0-9A-HJ-NP-Z]{6}\.arb$/.test(f))
        .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t)
      for (const { f } of files.slice(KEEP_REPORTS)) { try { fs.unlinkSync(path.join(dir, f)) } catch {} }
    } catch {}
  }

  ipcMain.handle('feedback:package', async (e) => {
    if (!fromApp(e)) return
    if (last && now() - last.at < THROTTLE_MS) return { throttled: true, shortId: last.shortId, file: last.file }
    try {
      const bounds = win.getBounds()
      let shots = { screens: {}, partial: true }
      try { shots = await sweep({ uiUrl, bounds, dests: DESTS, BrowserWindow, session, visibleWin: win }) } catch {}
      const id = shortId()
      const meta = {
        id: randomUUID(), ts: new Date(now()).toISOString(), appVersion: version, channel, platform: process.platform,
        arch: process.arch, osRelease: os.release(), electron: process.versions.electron || null,
        installId: installId(path.join(userData, 'data')), theme: theme(), shortId: id,
      }
      const src = { ...(sources() || {}), renderer: await rendererErrors() }
      const body = await bundle({ meta, sources: src, get: fetchJson, readJson: readDesktopSettings, bounds, screens: shots.screens })
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `arbiter-report-${id}.arb`)
      fs.writeFileSync(file, sealFn(body), { mode: 0o600 })
      produced.set(id, file)
      last = { at: now(), shortId: id, file }
      prune()
      return { shortId: id, file, screensPartial: !!shots.partial }
    } catch (err) {
      return { error: String(err && err.message || err) }
    }
  })
  ipcMain.handle('feedback:drag', (e, p) => { const f = fileOf(p); if (fromApp(e) && f) win.webContents.startDrag({ file: f, icon }) })
  ipcMain.handle('feedback:reveal', (e, p) => { const f = fileOf(p); if (fromApp(e) && f) shell.showItemInFolder(f) })
  ipcMain.handle('feedback:discord', (e) => { if (fromApp(e)) shell.openExternal(DISCORD_INVITE) })
}

module.exports = { registerFeedback, shortId, DISCORD_INVITE, KEEP_REPORTS, THROTTLE_MS }
