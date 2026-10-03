// desktop/scripts/webview-guard.mjs (review, 2026-10-03): the drive helper's page-changing commands (nav, click, type,
// key) can make the trade site run a search, and the Workspace saves every search into the ACTIVE row — the owner's,
// on a dev or packaged launch. They must name the row they work in, and run only when that row is the active one
// (or nothing is selected).
import test from 'node:test'
import assert from 'node:assert/strict'
const G = await import('../scripts/webview-guard.mjs')

test('page-changing commands need --row matching the active row; reading commands do not', () => {
  assert.equal(G.guard({ cmd: 'nav', row: 'n_mine', activeId: 'n_mine' }), null)
  assert.equal(G.guard({ cmd: 'click', row: null, activeId: null }), null, 'nothing selected: the home page')
  assert.match(G.guard({ cmd: 'nav', row: null, activeId: 'n_owner' }), /--row/)
  assert.match(G.guard({ cmd: 'type', row: 'n_mine', activeId: 'n_owner' }), /active row is n_owner/)
  assert.match(G.guard({ cmd: 'key', row: 'n_mine', activeId: 'n_owner' }), /active row/)
  for (const cmd of ['shot', 'url', 'wheel']) assert.equal(G.guard({ cmd, row: null, activeId: 'n_owner' }), null, cmd)
})

test('the helper applies the guard before sending anything', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../scripts/webview.mjs', import.meta.url), 'utf8')
  assert.match(src, /import \{ guard \} from '\.\/webview-guard\.mjs'/)
  assert.ok(src.indexOf('guard({') < src.indexOf("new WebSocket(t.webSocketDebuggerUrl)"), 'guarded before connecting')
})
