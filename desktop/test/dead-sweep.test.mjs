// Batch 10 — main.js vestiges, shared PyInstaller build scripts (audit F-25, F-27).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ROOT = new URL('../../', import.meta.url).pathname
const main = readFileSync(`${ROOT}desktop/src/main.js`, 'utf8')

test('main.js has no remote-mode vestiges', () => {
  assert.ok(!main.includes("mode: 'auto'") && !main.includes('function relaunch'))
  assert.ok(!main.includes("let backendKind = 'remote'"))
  assert.ok(main.includes('ARBITER_DEV_BACKEND_URL'))
  assert.ok(!/either the bundled local binary[\s\S]*or a remote server/.test(main))
  assert.ok(main.includes('const BACKDROP'))
})

test('Windows CI runs the same PyInstaller scripts the Mac uses', () => {
  const wf = readFileSync(`${ROOT}.github/workflows/release-desktop-win.yml`, 'utf8')
  assert.ok(wf.includes('desktop/build-backend.sh') && wf.includes('desktop/build-sidecar.sh'))
  assert.ok(!wf.includes('pyinstaller --noconfirm'))
  for (const f of ['build-backend.sh', 'build-sidecar.sh']) {
    const s = readFileSync(`${ROOT}desktop/${f}`, 'utf8')
    assert.ok(s.includes('uname -s') && s.includes('Scripts/activate'), f)
  }
})

test('engine.js has no stale PR comments', () => {
  assert.ok(!readFileSync(`${ROOT}desktop/src/trade/engine.js`, 'utf8').includes('PR6'))
})

test('OS notifications go through the main process on desktop', () => {
  const main = readFileSync(`${ROOT}desktop/src/main.js`, 'utf8')
  const preload = readFileSync(`${ROOT}desktop/src/preload.js`, 'utf8')
  assert.ok(main.includes("ipcMain.handle('notify'") && main.includes('Notification.isSupported()'))
  assert.ok(preload.includes("notify: (") && preload.includes("onNotifyClick: sub('notify:click')"))
})
