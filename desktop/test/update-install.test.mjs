// Regression tests for the 2026-11-24/25 Windows update VIDEO_SCHEDULER_INTERNAL_ERROR (0x119)
// timeline: quitAndInstall must flush workspace, finish stopAll (blocking uiohook thread join +
// diagnostic timers + backend), and close every BrowserWindow cleanly BEFORE spawning the NSIS
// installer, and installer.nsh must wait for Arbiter.exe to exit cleanly on silent /S updates
// instead of immediately running `taskkill /F /T /IM "Arbiter.exe"` into a live GPU process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'

const { runGracefulUpdateInstall } = await import('../src/update-install.js')
const icondiag = await import('../src/icondiag.js')
const modsdiag = await import('../src/modsdiag.js')

const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
const nshSrc = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8')

function fakeWindow(closeDelayMs = 20) {
  const ee = new EventEmitter()
  let destroyed = false
  return {
    isDestroyed: () => destroyed,
    once: (ev, fn) => ee.once(ev, fn),
    close: () => {
      if (closeDelayMs < 0) return
      setTimeout(() => {
        destroyed = true
        ee.emit('closed')
      }, closeDelayMs)
    },
  }
}

test('runGracefulUpdateInstall flushes, stops hooks/backend, and closes all windows BEFORE quitAndInstall', async () => {
  const events = []
  const w1 = fakeWindow(15)
  const w2 = fakeWindow(30)
  let windowsAliveAtQuitAndInstall = null

  await runGracefulUpdateInstall({
    flushWorkspace: async () => {
      events.push('flush:start')
      await new Promise((r) => { setTimeout(r, 10) })
      events.push('flush:done')
    },
    stopAll: () => {
      events.push('stopAll')
    },
    getWindows: () => [w1, w2],
    windowCloseTimeoutMs: 500,
    gpuSettleMs: 25,
    quitAndInstall: () => {
      windowsAliveAtQuitAndInstall = [!w1.isDestroyed(), !w2.isDestroyed()]
      events.push('quitAndInstall')
    },
  })

  assert.deepEqual(events, ['flush:start', 'flush:done', 'stopAll', 'quitAndInstall'])
  assert.deepEqual(windowsAliveAtQuitAndInstall, [false, false], 'every BrowserWindow must be closed before spawning the installer')
})

test('runGracefulUpdateInstall still calls quitAndInstall if a window refuses to close (bounded by timeout)', async () => {
  const stuck = fakeWindow(-1)
  let called = false
  await runGracefulUpdateInstall({
    stopAll: () => {},
    getWindows: () => [stuck],
    windowCloseTimeoutMs: 30,
    gpuSettleMs: 5,
    quitAndInstall: () => { called = true },
  })
  assert.equal(called, true)
})

test('runGracefulUpdateInstall forwards quitAndInstall exceptions to onError', async () => {
  let caught = null
  await runGracefulUpdateInstall({
    stopAll: () => {},
    getWindows: () => [],
    gpuSettleMs: 0,
    quitAndInstall: () => { throw new Error('spawn failed') },
    onError: (e) => { caught = e },
  })
  assert.match(String(caught), /spawn failed/)
})

test('icondiag and modsdiag return disposers that cancel pending timers before quit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const logs = []
  const stopIcons = icondiag.install({
    win: () => ({ isDestroyed: () => false, webContents: { executeJavaScript: async () => ({}) } }),
    session: { webRequest: { onCompleted: () => {}, onErrorOccurred: () => {} } },
    backendUrl: () => 'http://127.0.0.1:1',
    log: (m) => logs.push(m),
  })
  const stopMods = modsdiag.install({
    win: () => ({ isDestroyed: () => false, webContents: { executeJavaScript: async () => 'closed' } }),
    backendUrl: () => 'http://127.0.0.1:1',
    log: (m) => logs.push(m),
  })
  assert.equal(typeof stopIcons, 'function')
  assert.equal(typeof stopMods, 'function')
  stopIcons()
  stopMods()
  t.mock.timers.tick(600000)
  await Promise.resolve()
  assert.deepEqual(logs, [], 'disposed diagnostic probes must not fire mid-quit')
})

test('installer.nsh waits for Arbiter.exe to exit cleanly during silent /S updates before any taskkill fallback', () => {
  const preInit = nshSrc.match(/!macro preInit([\s\S]*?)!macroend/)?.[1] || ''
  assert.ok(preInit, 'preInit macro must exist')
  const firstIfSilent = preInit.indexOf('IfSilent')
  const arbiterKill = preInit.indexOf('taskkill /F /T /IM "Arbiter.exe"')
  assert.ok(firstIfSilent !== -1, 'preInit must branch on IfSilent')
  assert.ok(arbiterKill > firstIfSilent, 'Arbiter.exe force-kill must NOT run before IfSilent graceful wait')
  assert.match(preInit, /wait_arbiter_loop[\s\S]*tasklist[\s\S]*Arbiter\.exe[\s\S]*Sleep\s+250/)
})

test('main.js wires graceful update teardown, guards window-all-closed, and stops polling once downloaded', () => {
  assert.ok(mainSrc.includes("require('./update-install.js')"))
  assert.ok(mainSrc.includes('runGracefulUpdateInstall('))
  assert.match(mainSrc, /app\.on\('window-all-closed'[\s\S]{0,120}_installingUpdate/)
  assert.match(mainSrc, /stopAll\s*=\s*\(\)\s*=>\s*\{\s*stopDiag\(\)/)
  assert.match(mainSrc, /if\s*\(!_updateDownloaded\)\s*autoUpdater\.checkForUpdates/)
})
