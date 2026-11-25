// Graceful Windows update handoff before electron-updater's quitAndInstall.
//
// electron-updater's BaseUpdater.quitAndInstall spawns the NSIS installer FIRST and only calls
// app.quit() afterwards. When main still has an open BrowserWindow (live Chromium GPU process) and
// a blocking before-quit teardown (uiohook's synchronous uv_thread_join takes 1-3 s on Windows),
// the NSIS installer's preInit raced ahead and hard-killed Arbiter.exe mid-GPU-teardown, provoking
// Windows VIDEO_SCHEDULER_INTERNAL_ERROR (0x119) BSODs on Electron 45.
//
// Order here: flush workspace -> stop all background hooks/timers/backend -> close every open
// BrowserWindow and wait for Chromium to release its renderer/GPU surfaces -> quitAndInstall.
'use strict'
const { ignored } = require('./ignored.js')

/**
 * @typedef {{ isDestroyed(): boolean, once(ev: string, fn: () => void): void, close(): void }} ClosableWindow
 */

/**
 * Close every open window and wait until all emit 'closed' (or timeoutMs elapses).
 * @param {ClosableWindow[]} windows
 * @param {number} timeoutMs
 */
function closeWindowsAndWait(windows, timeoutMs) {
  const open = (windows || []).filter((w) => w && !w.isDestroyed())
  if (!open.length) return Promise.resolve()
  return new Promise((resolve) => {
    let remaining = open.length
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    const onOneClosed = () => {
      remaining -= 1
      if (remaining <= 0) done()
    }
    for (const w of open) {
      w.once('closed', onOneClosed)
      try {
        w.close()
      } catch (e) {
        ignored('update:close-window', e)
        onOneClosed()
      }
    }
  })
}

/**
 * @param {{
 *   flushWorkspace?: () => Promise<void>,
 *   stopAll: () => void,
 *   getWindows: () => ClosableWindow[],
 *   quitAndInstall: () => void,
 *   windowCloseTimeoutMs?: number,
 *   gpuSettleMs?: number,
 *   onError?: (e: unknown) => void,
 * }} deps
 */
async function runGracefulUpdateInstall(deps) {
  const {
    flushWorkspace,
    stopAll,
    getWindows,
    quitAndInstall,
    windowCloseTimeoutMs = 1500,
    gpuSettleMs = 300,
    onError,
  } = deps
  if (flushWorkspace) {
    try { await flushWorkspace() } catch (e) { ignored('update:flush-workspace', e) }
  }
  try { stopAll() } catch (e) { ignored('update:stop-all', e) }
  await closeWindowsAndWait(getWindows(), windowCloseTimeoutMs)
  if (gpuSettleMs > 0) {
    await new Promise((resolve) => { setTimeout(resolve, gpuSettleMs) })
  }
  try {
    quitAndInstall()
  } catch (e) {
    onError?.(e)
  }
}

module.exports = { runGracefulUpdateInstall }
