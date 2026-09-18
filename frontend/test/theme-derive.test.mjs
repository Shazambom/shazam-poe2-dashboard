// The proof that the builder's "sensible defaults" match the hand-made presets: deriving from each
// preset's eight primaries reproduces that preset's derived tokens within a stated tolerance.
// Prints the per-token error table (ΔE in OKLab; ~0.02 is a just-noticeable difference).
// Run:  node --test frontend/test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const { presetTables } = await import('../src/lib/themeCss.js')
const D = await import('../src/lib/themeDerive.js')
const C = await import('../src/lib/color.js')
const { keys, tables } = presetTables(readFileSync(join(SRC, 'styles.css'), 'utf8'))

// Tolerances. Mirrors (--accent-rgb …) are exact by construction and not measured.
const MAX_TOKEN_DE = 0.13    // the single worst token on any preset (Vault's --gold-dim is the outlier)
const MAX_MEAN_DE = 0.04     // per-preset mean over the measured derived tokens
const MIRRORS = new Set(['--accent-rgb', '--gain-rgb', '--loss-rgb', '--live-rgb', '--digest-rgb'])
const asHex = (v) => (v.includes(',') ? C.rgbToHex(v.split(',').map(Number)) : v)

test('the derivation key set is exactly the themed token set the linter expects', () => {
  assert.deepEqual([...D.TOKEN_KEYS].sort(), [...keys].sort())
  assert.equal(new Set(D.TOKEN_KEYS).size, D.TOKEN_KEYS.length)
  for (const k of D.PRIMARY_KEYS) assert.ok(D.TOKEN_KEYS.includes(k), k)
})

test('deriving from each preset\'s primaries reproduces its derived tokens (error table below)', () => {
  const rows = []
  // The benchmark is the hand-made presets. Owner-built presets (codified from the builder, with
  // pinned Advanced tokens such as Azmeri's dusty-rose --gold-2) are not a formula's job to reproduce.
  const HAND_MADE = new Set(['vault', 'ash', 'divinity', 'sekhemas', 'vaal'])
  for (const [id, t] of Object.entries(tables).filter(([id]) => HAND_MADE.has(id))) {
    const d = D.derive(D.primariesOf(t))
    for (const k of D.PRIMARY_KEYS) assert.equal(d[k], t[k], `${id} ${k} primary passes through`)
    for (const k of MIRRORS) assert.equal(d[k], t[k], `${id} ${k} mirror`)
    const measured = D.DERIVED_KEYS.filter(k => !MIRRORS.has(k))
    const errs = measured.map(k => [k, C.deltaE(asHex(t[k]), asHex(d[k]))])
    const mean = errs.reduce((a, [, e]) => a + e, 0) / errs.length
    const worst = errs.reduce((a, r) => (r[1] > a[1] ? r : a))
    rows.push({ preset: id, mean: mean.toFixed(3), worst: `${worst[0]} ${worst[1].toFixed(3)}`, ...Object.fromEntries(errs.map(([k, e]) => [k.slice(2), e.toFixed(3)])) })
    for (const [k, e] of errs) assert.ok(e <= MAX_TOKEN_DE, `${id} ${k}: ΔE ${e.toFixed(3)} > ${MAX_TOKEN_DE} (preset ${t[k]}, derived ${d[k]})`)
    assert.ok(mean <= MAX_MEAN_DE, `${id}: mean ΔE ${mean.toFixed(3)} > ${MAX_MEAN_DE}`)
  }
  console.table(rows.map(({ preset, mean, worst }) => ({ preset, mean, worst })))
  console.table(rows.map(({ preset, mean, worst, ...per }) => ({ preset, ...per })))
})

test('every derived table passes the contrast rules the linter enforces on presets', () => {
  for (const [id, t] of Object.entries(tables)) {
    const issues = D.contrastIssues(D.derive(D.primariesOf(t)))
    assert.deepEqual(issues, [], `${id}: ${issues.map(i => `${i.fg}/${i.bg} ${i.ratio.toFixed(2)}`).join(', ')}`)
  }
})

test('light vs dark is read from the primaries, and the light branch lightens panel-hi', () => {
  assert.equal(D.isLightTheme(D.primariesOf(tables.divinity)), true)
  assert.equal(D.isLightTheme(D.primariesOf(tables.vault)), false)
  const d = D.derive(D.primariesOf(tables.divinity))
  assert.ok(C.lightness(d['--panel-hi']) > C.lightness(d['--panel']))
  assert.ok(C.lightness(d['--panel-2']) < C.lightness(d['--panel']))
})

test('rederive keeps a preset copy exact when primaries do not change, and carries pins along', () => {
  const t = tables.ash
  assert.deepEqual(D.rederive(t, D.primariesOf(t)), t)
  // A pinned --line survives a background change as an offset, not a snap back to the formula.
  const pinned = { ...t, '--line': '#ff0000' }
  const moved = D.rederive(pinned, { ...D.primariesOf(t), '--bg': '#000000' })
  assert.notEqual(moved['--line'], D.derive({ ...D.primariesOf(t), '--bg': '#000000' })['--line'])
  const [, c] = C.hexToOklch(moved['--line'])
  assert.ok(c > 0.15, 'still strongly red')
  assert.equal(moved['--accent-rgb'], C.hexToTriplet(moved['--gold']))
})

test('contrast guard flags a failing pair and auto-fix nudges only the foreground', () => {
  const bad = { ...tables.vault, '--muted': tables.vault['--panel'] }
  const issues = D.contrastIssues(bad)
  assert.ok(issues.some(i => i.fg === '--muted' && i.bg === '--panel'))
  const fixed = D.autoFixContrast(bad)
  assert.deepEqual(D.contrastIssues(fixed), [])
  assert.equal(fixed['--panel'], bad['--panel'])
  assert.equal(fixed['--bg'], bad['--bg'])
})

test('validTable / sanitizeTable / isCustomId', () => {
  assert.equal(D.validTable(tables.vault), true)
  assert.equal(D.validTable({ ...tables.vault, '--bg': 'red' }), false)
  const { '--bg': _, ...missing } = tables.vault
  assert.equal(D.validTable(missing), false)
  assert.equal(D.sanitizeTable({ ...tables.vault, '--bg': '#ABC', '--wash-rgb': '1, 2, 3' })['--bg'], '#aabbcc')
  assert.equal(D.sanitizeTable({ ...tables.vault, '--wash-rgb': '1, 2, 3' })['--wash-rgb'], '1,2,3')
  assert.equal(D.isCustomId('custom-0badf00d'), true)
  assert.equal(D.isCustomId('vault'), false)
  assert.ok(D.isCustomId(D.newThemeId()))
})
