// Pins the workspace store's load-failure contract: a failed GET must never arm persist —
// otherwise the next mutation PUTs an empty tree over the user's real one (data loss).
// Run:  node --test frontend/test/
import test from 'node:test'
import assert from 'node:assert/strict'

const calls = []
let getMode = 'fail'
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET'
  calls.push({ url, method })
  if (!String(url).includes('/api/trading/workspace')) return { ok: true, status: 200, json: async () => ({}), text: async () => '' }
  if (method === 'GET') {
    if (getMode === 'fail') return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) }
    return { ok: true, status: 200, json: async () => ({ workspace: { version: 2, tree: [{ id: 'n_real', kind: 'search', name: 'Real', slug: 'abc' }], layout: null, openTabs: [] } }), text: async () => '' }
  }
  return { ok: true, status: 200, json: async () => ({ workspace: JSON.parse(opts.body).workspace }), text: async () => '' }
}

const { useWorkspace, loadWorkspace } = await import('../src/lib/workspaceStore.js')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const puts = () => calls.filter(c => c.method === 'PUT')

test('a failed load sets loadError and refuses to persist mutations', async () => {
  getMode = 'fail'
  await loadWorkspace()
  const st = useWorkspace.getState()
  assert.equal(st.loaded, true)
  assert.ok(st.loadError, 'loadError is set')
  assert.deepEqual(st.tree, [])

  st.addFolder(null)
  st.addSearch(null, { type: 'search', slug: 'x', live: false }, 'X')
  st.setActive('n_whatever')
  await sleep(900)   // longer than the 700 ms debounce
  assert.equal(puts().length, 0, 'no PUT after a load failure')
  assert.deepEqual(useWorkspace.getState().tree, [], 'mutations are refused while loadError is set')
})

test('retry clears loadError, hydrates the real tree, and persists again', async () => {
  getMode = 'ok'
  await loadWorkspace()
  await sleep(10)
  const st = useWorkspace.getState()
  assert.equal(st.loadError, null)
  assert.equal(st.tree.length, 1)
  st.addFolder(null)
  await sleep(900)
  assert.equal(puts().length, 1, 'persist works again after a successful load')
  assert.equal(useWorkspace.getState().tree.length, 2)
})
