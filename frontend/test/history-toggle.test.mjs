// The rail slider and the Settings slider read/write ONE setting (settings.ee2History) through
// saveHistoryPrefs; off → the store drops with reason 'disabled'. Prefs are clamped from settings.
import test from 'node:test'
import assert from 'node:assert/strict'
const putBodies = []
globalThis.window = { poe2desktop: { ee2: { setEnabled: (v) => putBodies.push(['main', v]) } } }
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('/api/settings') && opts.method === 'PUT') { const b = JSON.parse(opts.body); putBodies.push(['settings', b.patch]); return { ok: true, status: 200, json: async () => ({ ee2History: b.patch.ee2History }), text: async () => '' } }
  return { ok: true, status: 200, json: async () => ({ workspace: { version: 2, tree: [] } }), text: async () => '' }
}
const { useWorkspace, HISTORY_SYS } = await import('../src/lib/workspaceStore.js')
const { historyPrefsFromSettings, saveHistoryPrefs } = await import('../src/lib/ee2History.js')
const st = () => useWorkspace.getState()

test('historyPrefsFromSettings clamps and defaults', () => {
  assert.deepEqual(historyPrefsFromSettings(null), { enabled: true, max: 200, retentionDays: 14 })
  assert.deepEqual(historyPrefsFromSettings({ ee2History: { enabled: false, max: 5, retentionDays: 500 } }), { enabled: false, max: 20, retentionDays: 90 })
  assert.deepEqual(historyPrefsFromSettings({ ee2History: { max: '300', retentionDays: 'x' } }), { enabled: true, max: 300, retentionDays: 14 })
})

test('saveHistoryPrefs writes the store, tells main, and PUTs settings.ee2History; off → dropped/disabled', async () => {
  st().hydrate({ version: 2, tree: [], layout: null, openTabs: [] }); await new Promise(r => setTimeout(r, 5))
  const next = await saveHistoryPrefs({ enabled: false })
  assert.equal(next.enabled, false)
  assert.deepEqual(st().historyPrefs, { enabled: false, max: 200, retentionDays: 14 })
  assert.deepEqual(putBodies.find(p => p[0] === 'main'), ['main', false])
  assert.deepEqual(putBodies.find(p => p[0] === 'settings'), ['settings', { ee2History: { enabled: false, max: 200, retentionDays: 14 } }])
  assert.deepEqual(st().ingest({ source: 'ee2', q: '{}', name: 'x', folder: HISTORY_SYS }), { result: 'dropped', reason: 'disabled' })
  await saveHistoryPrefs({ enabled: true, max: 50 })
  assert.equal(st().ingest({ source: 'ee2', q: '{}', name: 'x', folder: HISTORY_SYS }).result, 'added')
})
