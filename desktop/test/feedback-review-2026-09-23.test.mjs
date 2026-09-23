// Reproductions from the 2026-09-23 review, desktop side. Both FAIL on main.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { registerFeedback } = await import('../src/feedback/index.js')

// The same harness feedback-package.test.mjs uses, with a sweep the test releases by hand.
function harness(over = {}) {
  const handlers = {}, calls = []
  const win = { webContents: { id: 1, startDrag: () => {}, capturePage: async () => ({}) }, getBounds: () => ({ width: 1440, height: 847 }) }
  const userData = mkdtempSync(join(tmpdir(), 'arb-fb-'))
  let t = 1_000_000
  registerFeedback({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn } },
    BrowserWindow: class {}, session: {}, win, uiUrl: 'http://127.0.0.1:1', backendUrl: 'http://127.0.0.1:2', userData,
    version: '0.3.3', channel: 'beta', theme: () => 'vault',
    sources: () => ({ main: ['m'], backend: 'b', updater: ['u'] }),
    shell: { showItemInFolder: () => {}, openExternal: () => {} },
    icon: 'ICON',
    bundle: async () => Buffer.from('BUNDLE'),
    sealFn: (b) => Buffer.concat([Buffer.from('ARB1'), b]),
    get: async () => ({}),
    now: () => t,
    ...over,
  })
  return { handlers, calls, userData, from: () => ({ sender: { id: 1 } }) }
}

test('closing and reopening the dialog while a report is packaging does not start a second sweep', async () => {
  // The sweep's snap window shares ONE session.webRequest listener; a second concurrent sweep
  // replaces the first's write filter and whichever finishes first removes the other's. So while
  // one package is in flight, another request must join it, not start another.
  let release
  let sweeps = 0
  const gate = new Promise(r => { release = r })
  const h = harness({ sweep: async () => { sweeps++; await gate; return { screens: { current: Buffer.from('jpg') }, partial: false } } })
  const first = h.handlers['feedback:package'](h.from())
  const second = h.handlers['feedback:package'](h.from())     // the dialog was closed and reopened
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(sweeps, 1, `two sweeps ran concurrently (${sweeps})`)
  assert.equal(b.shortId, a.shortId, 'the second request must get the in-flight report')
  assert.equal(readdirSync(join(h.userData, 'reports')).length, 1)
})

test('the vendored EE2 trade stats are written in a stable order', () => {
  // GGG returns /trade/data/stats in a different order on every fetch. The sync writes it as
  // fetched, so every release commits an 850 KB file whose CONTENT is unchanged. Stable order
  // (by id, within each group) makes an unchanged upstream an unchanged file.
  const p = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src', 'vendor', 'ee2-query', 'data', 'trade', 'stats.json')
  const stats = JSON.parse(readFileSync(p, 'utf8'))
  for (const group of stats.result) {
    const ids = group.entries.map(e => e.id)
    const sorted = [...ids].sort()
    assert.deepEqual(ids, sorted, `group "${group.id}" is in fetch order, not a stable one`)
  }
})

test('a report carries neither the PoE account name nor the OS user name', async () => {
  // /api/status carries oauth.username; /api/diag carries data_dir, whose path names the OS user.
  // Owner (2026-09-23): both are redacted, not disclosed.
  const { redactDeep } = await import('../src/feedback/redact.js')
  const status = { league: 'Forbidden Rites', oauth: { logged_in: true, username: 'RealPlayerName', scope: 'account:profile' } }
  const diag = { time: 1, data_dir: '/Users/realosuser/Library/Application Support/Arbiter/data', analytics: { jobs: [] } }
  const out = JSON.stringify(redactDeep({ status, diag }))
  assert.ok(!out.includes('RealPlayerName'), `account name leaked: ${out}`)
  assert.ok(!out.includes('realosuser'), `OS user name leaked: ${out}`)
  assert.ok(out.includes('Forbidden Rites') && out.includes('account:profile'), 'the rest of the state must survive')
})
