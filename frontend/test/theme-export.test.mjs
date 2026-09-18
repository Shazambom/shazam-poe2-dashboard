// Export produces a ready-to-paste preset block: exactly the themed key set scripts/lint-style.mjs
// demands, in the presets' own order/grouping, plus JSON with the same table.
// Run:  node --test frontend/test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const css = readFileSync(join(SRC, 'styles.css'), 'utf8')
const { presetTables, parseThemeBlocks, NEVER_THEMED } = await import('../src/lib/themeCss.js')
const D = await import('../src/lib/themeDerive.js')
const { keys, tables } = presetTables(css)

// The linter's reading of the themed set: every :root token minus NEVER_THEMED.
const lintKeys = [...parseThemeBlocks(css).root.keys()].filter(k => !NEVER_THEMED.has(k))

test('themeCss reads Vault (bare :root) and every preset block', () => {
  assert.deepEqual(Object.keys(tables), ['vault', 'ash', 'divinity', 'sekhemas', 'vaal', 'azmeri'])
  assert.deepEqual(keys, lintKeys)
  // Spot-check the parser against the stylesheet itself (preset values are the owner's to change).
  const cssText = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  const ashBlock = cssText.match(/:root\[data-theme="ash"\] \{([^}]*)\}/)[1]
  assert.equal(tables.ash['--wash-rgb'], ashBlock.match(/--wash-rgb:\s*([^;]+);/)[1].trim())
  assert.equal(tables.vault['--bg'], cssText.match(/:root \{[^}]*?--bg:\s*(#[0-9a-f]{6})/i)[1])
})

test('exportCss re-parses to exactly the linter key set, in the presets\' order', () => {
  const theme = { id: 'custom-0badf00d', name: 'My Ash', base: 'ash', colors: tables.ash }
  const out = D.exportCss(theme)
  assert.match(out, /^\/\* My Ash — custom theme, started from ash \*\/\n:root\[data-theme="my-ash"\] \{\n/)
  const { presets } = parseThemeBlocks(out)
  const block = presets['my-ash']
  assert.ok(block, 'block parses with the linter grammar')
  assert.deepEqual([...block.keys()].sort(), [...lintKeys].sort())
  // Same order as the ash block in styles.css.
  assert.deepEqual([...block.keys()], [...parseThemeBlocks(css).presets.ash.keys()])
  for (const k of lintKeys) assert.equal(block.get(k), tables.ash[k], k)
  // Grouped per line like the presets: 7 declaration lines between the braces.
  assert.equal(out.split('\n').filter(l => l.startsWith('  --')).length, 7)
})

test('a derived theme exports with mirrors equal to their colours (what lint:style checks)', () => {
  const colors = D.derive({ '--bg': '#101418', '--panel': '#1c2230', '--ink': '#eef0f4', '--gold': '#e0b050', '--gain': '#70d0a0', '--loss': '#e07a68', '--live': '#7fb4d9', '--digest': '#b39ddb' })
  const block = parseThemeBlocks(D.exportCss({ name: 'x', colors })).presets.x
  const rgb = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(',')
  for (const [trip, col] of [['--accent-rgb', '--gold'], ['--gain-rgb', '--gain'], ['--loss-rgb', '--loss'], ['--live-rgb', '--live'], ['--digest-rgb', '--digest']]) {
    assert.equal(block.get(trip), rgb(block.get(col)), trip)
  }
})

test('exportJson carries id/name/base and the full table', () => {
  const theme = { id: 'custom-0badf00d', name: 'Mine', base: 'vault', colors: tables.vault }
  const j = JSON.parse(D.exportJson(theme))
  assert.equal(j.id, 'custom-0badf00d'); assert.equal(j.name, 'Mine'); assert.equal(j.base, 'vault')
  assert.deepEqual(Object.keys(j.colors), D.TOKEN_KEYS)
  assert.deepEqual(j.colors, tables.vault)
})

test('export slug: name → data-theme id', () => {
  assert.equal(D.exportSlug('Arbiter of Ash copy'), 'arbiter-of-ash-copy')
  assert.equal(D.exportSlug('  --weird?? '), 'weird')
  assert.equal(D.exportSlug(''), 'custom')
})
