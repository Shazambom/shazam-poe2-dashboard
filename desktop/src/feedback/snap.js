// The invisible sweep: photograph every screen of the app for a feedback report without the user
// seeing anything move. The visible window is captured first (modals and all), then a second,
// never-shown BrowserWindow loads the same UI in `?snap=1` mode (renders everything, polls,
// persists and notifies nothing), is walked through the dests via window.__arbiterSnap and
// captured with { stayHidden: true }. Every screen is resized to 1200 px wide and JPEG q60.
//
// Isolation is mechanical, not a convention: the snap window gets its own minimal preload
// (preload-snap.js — no IPC writer reachable), no <webview>, and a session-level filter that
// cancels any non-GET /api request from ITS webContents, so a future hook that forgets the SNAP
// guard still cannot write user data. A screenshot never blocks a report: any failure marks
// `partial` and the sweep carries on; the window is destroyed and the filter removed in `finally`.
'use strict'
const path = require('path')

const SNAP_URL_SUFFIX = '/?snap=1'
const WIDTH = 1200
const QUALITY = 60

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])
const jpeg = (img) => img.resize({ width: WIDTH }).toJPEG(QUALITY)

async function sweepScreens({ uiUrl, bounds, dests, BrowserWindow, session, visibleWin, backgroundColor,
                              perScreenMs = 2500, totalMs = 20000 }) {
  const screens = {}
  let partial = false
  const deadline = Date.now() + totalMs
  try { screens.current = jpeg(await withTimeout(visibleWin.webContents.capturePage(), perScreenMs)) } catch { partial = true }

  const urls = [`${uiUrl}/api/*`]
  let snap = null
  try {
    let snapId = -1
    session.webRequest.onBeforeRequest({ urls }, (d, cb) => cb({ cancel: d.webContentsId === snapId && d.method !== 'GET' }))
    snap = new BrowserWindow({
      show: false, width: bounds.width, height: bounds.height, backgroundColor,
      webPreferences: { preload: path.join(__dirname, '..', 'preload-snap.js'), sandbox: true, contextIsolation: true,
                        webviewTag: false, backgroundThrottling: false },
    })
    snapId = snap.webContents.id
    await withTimeout(snap.loadURL(`${uiUrl}${SNAP_URL_SUFFIX}`), perScreenMs * 2)
    for (const d of dests) {
      const budget = Math.min(perScreenMs, deadline - Date.now())   // a screen never outlives the sweep
      if (budget <= 0) { partial = true; break }
      try {
        const go = `window.__arbiterSnap(${JSON.stringify({ section: d.section, sub: d.sub })})`
        await withTimeout(snap.webContents.executeJavaScript(go), budget)
        screens[d.id] = jpeg(await withTimeout(snap.webContents.capturePage(undefined, { stayHidden: true }), budget))
      } catch { partial = true }
    }
  } catch { partial = true }
  finally {
    try { session.webRequest.onBeforeRequest({ urls }, null) } catch {}
    try { if (snap && !snap.isDestroyed()) snap.destroy() } catch {}
  }
  return { screens, partial }
}

module.exports = { sweepScreens, SNAP_URL_SUFFIX, WIDTH, QUALITY }
