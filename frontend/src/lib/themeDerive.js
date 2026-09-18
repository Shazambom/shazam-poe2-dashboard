// Custom themes: eight primaries in, the full preset colour table out.
//
// A custom theme is a colour table for the SAME tokens the presets in styles.css define (nothing
// else — themes are colour-only). The user picks eight PRIMARIES; every other token is derived
// here with the relationships the hand-made presets already follow (measured in OKLCH across
// vault/ash/sekhemas/vaal, and divinity for the light-mode branch; frontend/test/theme-derive.test.mjs
// pins how closely each preset is reproduced). The Advanced disclosure in the builder lets the owner
// pin any derived token; a pinned value survives later primary changes because `rederive` keeps each
// token's offset from its derived value rather than snapping back to the formula.
import { adjustL, contrast, ensureContrast, hexToOklab, hexToOklch, hexToTriplet, lightness, mix, normHex, oklabToHex, oklchToHex } from './color.js'

export const PRIMARIES = [
  ['--bg', 'Background'], ['--panel', 'Panel'], ['--ink', 'Text'], ['--gold', 'Accent'],
  ['--gain', 'Gain'], ['--loss', 'Loss'], ['--live', 'Live'], ['--digest', 'Digest'],
]
export const PRIMARY_KEYS = PRIMARIES.map(([k]) => k)

// Every themed token, in the order the preset blocks in styles.css write them (grouped per line).
export const EXPORT_LINES = [
  ['--bg', '--bg-2', '--panel', '--panel-2', '--panel-hi', '--surface-1', '--surface-pop'],
  ['--line', '--line-strong', '--line-hover'],
  ['--ink', '--ink-2', '--muted'],
  ['--gold', '--gold-2', '--gold-dim', '--gold-3', '--ink-on-gold'],
  ['--gain', '--loss', '--live', '--digest', '--recipe'],
  ['--accent-rgb', '--gain-rgb', '--loss-rgb', '--live-rgb', '--digest-rgb', '--wash-rgb'],
  ['--backdrop'],
]
export const TOKEN_KEYS = EXPORT_LINES.flat()
export const DERIVED_KEYS = TOKEN_KEYS.filter(k => !PRIMARY_KEYS.includes(k))
// The *-rgb triplets are not colours of their own — they mirror a colour token (lint:style's RGB_PAIRS + wash).
const TRIPLET_OF = { '--accent-rgb': '--gold', '--gain-rgb': '--gain', '--loss-rgb': '--loss', '--live-rgb': '--live', '--digest-rgb': '--digest' }
export const isTriplet = (k) => k.endsWith('-rgb')

// WCAG pairs the linter enforces on presets: [foreground, background, minimum ratio].
export const CONTRAST_RULES = [
  ['--ink', '--panel', 7], ['--ink', '--bg', 7], ['--ink-2', '--panel', 4.5], ['--muted', '--panel', 4.5], ['--muted', '--bg', 4.5],
  ['--gold', '--panel', 4.5], ['--gain', '--panel', 4.5], ['--loss', '--panel', 4.5],
  ['--live', '--panel', 4.5], ['--digest', '--panel', 4.5], ['--recipe', '--panel', 4.5], ['--ink-on-gold', '--gold', 4.5],
]

export const isLightTheme = (p) => lightness(p['--ink']) < lightness(p['--bg'])

// The eight primaries → the full table. Constants are the per-relationship medians measured on the presets.
export function derive(p) {
  const bg = normHex(p['--bg']), panel = normHex(p['--panel']), ink = normHex(p['--ink']), gold = normHex(p['--gold'])
  const gain = normHex(p['--gain']), loss = normHex(p['--loss']), live = normHex(p['--live']), digest = normHex(p['--digest'])
  const light = lightness(ink) < lightness(bg)
  const s = light ? -1 : 1                       // "up" = toward the ink
  const t = {}
  t['--bg'] = bg
  t['--bg-2'] = adjustL(bg, s * 0.03)
  t['--panel'] = panel
  t['--panel-2'] = adjustL(panel, s * 0.04)
  t['--panel-hi'] = adjustL(panel, light ? 0.035 : 0.08)   // the lit edge is always lighter, even on parchment
  t['--surface-1'] = mix(bg, panel, 0.4)
  t['--surface-pop'] = mix(panel, t['--panel-hi'], light ? 0.6 : 0.16)
  // Rules keep the panel's tint (a mix toward near-white ink would grey an oxblood or rust line).
  const [, panelC] = hexToOklch(panel)
  const tinted = (hex) => { const [L, c, h] = hexToOklch(hex); return oklchToHex([L, Math.max(c, panelC), h]) }
  t['--line'] = tinted(mix(panel, ink, light ? 0.21 : 0.12))
  t['--line-strong'] = tinted(mix(panel, ink, light ? 0.36 : 0.23))
  t['--line-hover'] = tinted(mix(panel, ink, light ? 0.46 : 0.32))
  t['--ink'] = ink
  t['--ink-2'] = mix(ink, panel, 0.165)
  t['--muted'] = mix(ink, panel, light ? 0.34 : 0.39)
  t['--gold'] = gold
  t['--gold-2'] = adjustL(gold, light ? 0.03 : 0.07)
  // The dim accent (focus borders, the hover ring) sits 75% of the way to the panel in lightness but
  // keeps the accent's hue at ~half chroma — a shadowed gold, not a grey.
  const [goldL, goldC, goldH] = hexToOklch(gold)
  t['--gold-dim'] = oklchToHex([goldL + (lightness(panel) - goldL) * 0.75, goldC * 0.55, goldH])
  t['--gold-3'] = adjustL(gold, light ? -0.08 : -0.15)
  t['--ink-on-gold'] = ensureContrast(mix(gold, light ? t['--panel-hi'] : bg, 0.93), gold, 4.5)
  t['--gain'] = gain
  t['--loss'] = loss
  t['--live'] = live
  t['--digest'] = digest
  // Recipe edges are the warm brass every preset shares — it does not follow the accent (Sekhemas
  // has a cyan accent and gold recipe rings). Lightness flips for a light surface.
  t['--recipe'] = oklchToHex([light ? 0.51 : 0.82, 0.10, 82])
  // Sensible defaults never violate the linter's floors: the DERIVED text-sized tokens are nudged
  // away from their surface until they read (a bright ember panel pulls `muted` below 4.5:1 —
  // the owner's tuned Ash found this). Primaries the user chose are never touched here; those
  // surface as warnings with Auto-fix instead.
  t['--ink-2'] = ensureContrast(t['--ink-2'], panel, 4.5)
  t['--muted'] = ensureContrast(ensureContrast(t['--muted'], panel, 4.5), bg, 4.5)
  t['--recipe'] = ensureContrast(t['--recipe'], panel, 4.5)
  for (const [trip, col] of Object.entries(TRIPLET_OF)) t[trip] = hexToTriplet(t[col])
  // The ambient body glow takes the surface's own hue, saturated — slate → blue, rust → ember, oxblood → blood.
  const [, , panelH] = hexToOklch(panel)
  t['--wash-rgb'] = hexToTriplet(oklchToHex([light ? 0.77 : 0.5, Math.min(0.18, Math.max(0.08, panelC * 5)), panelH]))
  t['--backdrop'] = light ? mix(bg, t['--bg-2'], 0.6) : mix(bg, panel, 0.3)
  return Object.fromEntries(TOKEN_KEYS.map(k => [k, t[k]]))
}

export const primariesOf = (colors) => Object.fromEntries(PRIMARY_KEYS.map(k => [k, colors[k]]))

const tripletHex = (v) => { const m = String(v).split(',').map(Number); return m.length === 3 && m.every(Number.isFinite) ? '#' + m.map(n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('') : null }
const tokenHex = (k, v) => (isTriplet(k) ? tripletHex(v) : normHex(v))

// New primaries for an existing table: each derived token keeps its OKLab OFFSET from what the
// formula gave before, so a preset copy (whose hand-tuned tokens differ slightly from the formula)
// or an Advanced pin moves WITH the primaries instead of snapping to the formula.
export function rederive(colors, nextPrimaries) {
  const before = derive(primariesOf(colors)), after = derive(nextPrimaries)
  const out = { ...after }
  for (const k of DERIVED_KEYS) {
    if (k in TRIPLET_OF) continue   // mirrors, refreshed below
    const old = tokenHex(k, colors[k]), was = tokenHex(k, before[k]), now = tokenHex(k, after[k])
    if (!old || !was || !now) continue
    const O = hexToOklab(old), W = hexToOklab(was), N = hexToOklab(now)
    const hex = oklabToHex(N.map((x, i) => x + (O[i] - W[i])))
    out[k] = isTriplet(k) ? hexToTriplet(hex) : hex
  }
  for (const [trip, col] of Object.entries(TRIPLET_OF)) out[trip] = hexToTriplet(out[col])
  return out
}

// A whole table from primaries + optional derived-token overrides.
export function buildTable(primaries, overrides = {}) {
  const t = derive(primaries)
  for (const [k, v] of Object.entries(overrides)) if (DERIVED_KEYS.includes(k) && tokenHex(k, v)) t[k] = isTriplet(k) ? v : normHex(v)
  for (const [trip, col] of Object.entries(TRIPLET_OF)) t[trip] = hexToTriplet(t[col])
  return t
}

// Every contrast rule the table fails: [{ fg, bg, ratio, min }].
export function contrastIssues(colors) {
  const out = []
  for (const [fg, bg, min] of CONTRAST_RULES) {
    const a = normHex(colors[fg]), b = normHex(colors[bg])
    if (!a || !b) continue
    const ratio = contrast(a, b)
    if (ratio < min - 1e-9) out.push({ fg, bg, ratio, min })
  }
  return out
}
// Nudge every failing foreground (lightness only) until its rule passes. Never touches a background.
export function autoFixContrast(colors) {
  const t = { ...colors }
  for (const { fg, bg, min } of contrastIssues(t)) t[fg] = ensureContrast(t[fg], t[bg], min)
  for (const [trip, col] of Object.entries(TRIPLET_OF)) t[trip] = hexToTriplet(t[col])
  return t
}

// A table is "sane" when every key is present and well-formed (a settings blob from an older build or a hand edit can't paint garbage).
export const validTable = (colors) => !!colors && typeof colors === 'object' && TOKEN_KEYS.every(k => tokenHex(k, colors[k]) !== null)
// Canonical spelling (lowercase 6-digit hex, no spaces in triplets); only call on a valid table.
export const sanitizeTable = (colors) => Object.fromEntries(TOKEN_KEYS.map(k => [k, isTriplet(k) ? String(colors[k]).replace(/\s+/g, '') : normHex(colors[k])]))

// ---- Export: a ready-to-paste preset block (the presets' own layout) + JSON. ----
const slug = (s) => String(s || 'custom').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'custom'
export function exportCss(theme) {
  const id = slug(theme.name)
  const lines = EXPORT_LINES.map(keys => '  ' + keys.map(k => `${k}: ${theme.colors[k]};`).join(' '))
  return `/* ${theme.name} — custom theme${theme.base ? `, started from ${theme.base}` : ''} */\n:root[data-theme="${id}"] {\n${lines.join('\n')}\n}\n`
}
export function exportJson(theme) {
  return JSON.stringify({ id: theme.id, name: theme.name, base: theme.base, colors: Object.fromEntries(TOKEN_KEYS.map(k => [k, theme.colors[k]])) }, null, 2)
}
export const exportSlug = slug

export const newThemeId = () => 'custom-' + Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
export const isCustomId = (id) => typeof id === 'string' && /^custom-[0-9a-f]{8}$/.test(id)
