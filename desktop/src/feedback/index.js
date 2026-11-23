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
const { ignored } = require('../ignored.js')
const { backendFetch } = require('../local-backend.js')
const { readSettingsFile } = require('../settings-store.js')
const fsp = require('node:fs').promises
const path = require('node:path')
const { randomBytes, randomUUID } = require('node:crypto')
const os = require('node:os')
const { DESTS } = require('./dests.js')
const { installId } = require('./installid.js')

// The invite targets the #bug-reports forum channel of the Arbiter Discord server.
const DISCORD_INVITE = 'https://discord.gg/xxEDMkfqJg'
const KEEP_REPORTS = 10
const THROTTLE_MS = 60_000
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'   // no I, L, O, U: reads aloud without ambiguity
const shortId = () => Array.from(randomBytes(6), b => CROCKFORD[b % 32]).join('')
const ID_RE = /^[0-9A-HJ-NP-Z]{6}$/

/**
 * @param {{ ipcMain: any, BrowserWindow: any, session: any, win: any, uiUrl: string, backendUrl: string, userData: string,
 *   version: string, channel: string, theme: () => string, sources: any, shell: any, icon: any, sweep: (o: any) => Promise<any>,
 *   bundle: (o: any) => Promise<any>, sealFn: (plain: any, ...rest: any[]) => Buffer, get?: (p: string) => Promise<any>, now?: () => number }} deps
 */
function registerFeedback({ ipcMain, BrowserWindow, session, win, uiUrl, backendUrl, userData, version, channel, theme, sources,
                            shell, icon, sweep, bundle, sealFn, get, now = Date.now }) {
  const dir = path.join(userData, 'reports')
  const produced = new Map()       // shortId → file, this session only: the only files drag/reveal may touch
  let last = null                  // { at, shortId, file } — the throttle
  let inflight = null              // the package being built: a second request joins it, never starts another
  const fromApp = (e) => e && e.sender && win && !win.isDestroyed?.() && e.sender.id === win.webContents.id
  const fileOf = (p) => { const id = String(p && p.shortId || ''); return ID_RE.test(id) ? produced.get(id) : undefined }

  const fetchJson = get || (async (p) => {
    const r = await backendFetch(`${backendUrl}${p}`, { signal: AbortSignal.timeout(4000) })
    return r.json()
  })
  const readDesktopSettings = () => { try { return readSettingsFile(path.join(userData, 'desktop-settings.json')) } catch { return {} } }
  const rendererErrors = async () => { try { return await win.webContents.executeJavaScript('window.__arbiterErrors ? window.__arbiterErrors() : []') } catch { return [] } }
  const prune = async () => {
    try {
      const names = (await fsp.readdir(dir)).filter(f => /^arbiter-report-[0-9A-HJ-NP-Z]{6}\.arb$/.test(f))
      const files = []
      for (const f of names) files.push({ f, t: (await fsp.stat(path.join(dir, f))).mtimeMs })
      files.sort((a, b) => b.t - a.t)
      for (const { f } of files.slice(KEEP_REPORTS)) { try { await fsp.unlink(path.join(dir, f)) } catch (e) { ignored('feedback:prune-report', e) } }
    } catch (e) { ignored('feedback:prune-reports', e) }
  }

  // The sweep's snap window shares ONE session.webRequest listener, so two sweeps at once would
  // replace each other's write filter (the dialog closed and reopened mid-package). One at a time.
  ipcMain.handle('feedback:package', async (e) => {
    if (!fromApp(e)) return undefined
    if (last && now() - last.at < THROTTLE_MS) return { throttled: true, shortId: last.shortId, file: last.file }
    if (inflight) return inflight
    inflight = packageReport().finally(() => { inflight = null })
    return inflight
  })
  const packageReport = async () => {
    try {
      const bounds = win.getBounds()
      let shots = { screens: {}, partial: true }
      try { shots = await sweep({ uiUrl, bounds, dests: DESTS, BrowserWindow, session, visibleWin: win }) } catch (e) { ignored('feedback:sweep-screens', e) }
      const id = shortId()
      const meta = {
        id: randomUUID(), ts: new Date(now()).toISOString(), appVersion: version, channel, platform: process.platform,
        arch: process.arch, osRelease: os.release(), electron: process.versions.electron || null,
        installId: installId(path.join(userData, 'data')), theme: theme(), shortId: id,
        screensMissing: shots.missing || {},
      }
      const src = { ...(sources() || {}), renderer: await rendererErrors() }
      const body = await bundle({ meta, sources: src, get: fetchJson, readJson: readDesktopSettings, bounds, screens: shots.screens })
      await fsp.mkdir(dir, { recursive: true })
      const file = path.join(dir, `arbiter-report-${id}.arb`)
      await fsp.writeFile(file, sealFn(body), { mode: 0o600 })
      produced.set(id, file)
      last = { at: now(), shortId: id, file }
      await prune()
      return { shortId: id, file, screensPartial: Boolean(shots.partial) }
    } catch (err) {
      return { error: String(err && err.message || err) }
    }
  }
  ipcMain.handle('feedback:drag', (e, p) => { const f = fileOf(p); if (fromApp(e) && f) win.webContents.startDrag({ file: f, icon }) })
  ipcMain.handle('feedback:reveal', (e, p) => { const f = fileOf(p); if (fromApp(e) && f) shell.showItemInFolder(f) })
  ipcMain.handle('feedback:discord', (e) => { if (fromApp(e)) shell.openExternal(DISCORD_INVITE) })
}

module.exports = { registerFeedback, shortId, KEEP_REPORTS, THROTTLE_MS }
