// Pins themeStore's custom-theme painting: a custom id paints data-theme="custom" + one inline custom
// property per token on <html>; switching back to a preset clears them; boot reads the localStorage
// mirror; the desktop shell gets the custom backdrop. A ~30-line DOM stub stands in for the browser.
// Run:  node --test frontend/test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ---- stubs: document.documentElement (dataset + style), localStorage, poe2desktop, fetch ----
const style = new Map()
const html = {
  dataset: {},
  style: { setProperty: (k, v) => style.set(k, v), removeProperty: (k) => style.delete(k), get: (k) => style.get(k) },
}
globalThis.document = { documentElement: html }
const ls = new Map()
globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) }
const shell = []
globalThis.window = { poe2desktop: { setTheme: (id, backdrop) => { shell.push([id, backdrop]); return Promise.resolve(true) } } }
const puts = []
globalThis.fetch = async (url, opts) => {
  if (opts?.method === 'PUT') puts.push(JSON.parse(opts.body).patch)
  return { ok: true, json: async () => ({ theme: 'vault', custom_themes: [] }), text: async () => '' }
}

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const { presetTables } = await import('../src/lib/themeCss.js')
const { TOKEN_KEYS } = await import('../src/lib/themeDerive.js')
const { tables } = presetTables(readFileSync(join(SRC, 'styles.css'), 'utf8'))
const T = await import('../src/lib/themeStore.js')

const custom = { id: 'custom-0badf00d', name: 'Mine', base: 'ash', colors: { ...tables.ash, '--bg': '#010203', '--backdrop': '#0a0b0c' } }
const wait = () => new Promise(r => setTimeout(r, 5))

test('a preset paints only the attribute; the default clears it', () => {
  assert.equal(T.paintTheme('ash'), 'ash')
  assert.equal(html.dataset.theme, 'ash'); assert.equal(style.size, 0)
  assert.equal(T.paintTheme('vault'), 'vault')
  assert.equal(html.dataset.theme, undefined)
  assert.equal(T.paintTheme('bogus'), 'vault')
  assert.deepEqual(shell.at(-1), ['vault', undefined])
})

test('a custom id with its table paints data-theme="custom" + every token inline, and hands the shell its backdrop', () => {
  assert.equal(T.paintTheme(custom.id, custom.colors), custom.id)
  assert.equal(html.dataset.theme, 'custom')
  for (const k of TOKEN_KEYS) assert.equal(style.get(k), custom.colors[k], k)
  assert.equal(style.get('--bg'), '#010203')
  assert.deepEqual(shell.at(-1), ['custom', '#0a0b0c'])
  assert.equal(localStorage.getItem('arbiter.theme.v1'), custom.id)
  assert.deepEqual(JSON.parse(localStorage.getItem('arbiter.theme.custom.v1')), { id: custom.id, colors: custom.colors })
})

test('switching back to a preset clears every inline token and the custom mirror', () => {
  T.paintTheme('sekhemas')
  assert.equal(html.dataset.theme, 'sekhemas')
  assert.equal(style.size, 0)
  assert.equal(localStorage.getItem('arbiter.theme.custom.v1'), null)
})

test('a custom id without a table falls back to the default (no garbage paint)', () => {
  assert.equal(T.paintTheme(custom.id, null), 'vault')
  assert.equal(T.paintTheme(custom.id, { '--bg': 'nope' }), 'vault')
  assert.equal(style.size, 0)
})

test('bootTheme repaints the mirrored custom table before settings arrive', () => {
  T.paintTheme(custom.id, custom.colors)
  style.clear(); delete html.dataset.theme
  assert.equal(T.bootTheme(), custom.id)
  assert.equal(html.dataset.theme, 'custom'); assert.equal(style.get('--panel'), custom.colors['--panel'])
  // A stale mirror (different id) is ignored.
  localStorage.setItem('arbiter.theme.v1', 'custom-deadbeef')
  assert.equal(T.bootTheme(), 'vault')
})

test('the store: sync installs the custom list, apply paints + saves, saveCustoms persists and repaints the chosen theme', async () => {
  const st = T.useTheme.getState()
  st.sync('vault', [custom, { id: 'not-valid', colors: {} }])
  assert.deepEqual(T.useTheme.getState().customs.map(t => t.id), [custom.id])
  st.apply(custom.id)
  await wait()
  assert.equal(T.useTheme.getState().id, custom.id)
  assert.equal(html.dataset.theme, 'custom')
  assert.deepEqual(puts.at(-1), { theme: custom.id })
  // Edit the chosen theme: the new table is painted after the save.
  const edited = { ...custom, colors: { ...custom.colors, '--bg': '#0b0c0d' } }
  await T.useTheme.getState().saveCustoms([edited])
  assert.equal(style.get('--bg'), '#0b0c0d')
  assert.deepEqual(puts.at(-1), { custom_themes: [edited] })
  // Preview paints without persisting; endPreview restores the chosen table.
  T.useTheme.getState().preview({ ...edited.colors, '--bg': '#111111' })
  assert.equal(style.get('--bg'), '#111111'); assert.equal(T.useTheme.getState().previewing, true)
  T.useTheme.getState().endPreview()
  assert.equal(style.get('--bg'), '#0b0c0d'); assert.equal(T.useTheme.getState().previewing, false)
  // Deleting the chosen theme drops back to the default.
  await T.useTheme.getState().saveCustoms([])
  await wait()
  assert.equal(T.useTheme.getState().id, 'vault'); assert.equal(style.size, 0)
})
