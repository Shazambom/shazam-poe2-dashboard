#!/usr/bin/env node
// Arbiter UI style linter — zero dependencies, one source of truth.
//
// WHY THIS EXISTS (and not stylelint): the worst color drift in this app lives in
// Recharts/inline-style PROPS inside .jsx (e.g. stroke="#8f95a5" vs the --muted token
// #8b91a1 — two different "muted" greys). stylelint only sees .css, so covering both
// surfaces would mean stylelint + ESLint + plugins + two configs on a repo that keeps
// zero lint deps on purpose. This single file covers BOTH surfaces from ONE source of
// truth: the `:root` token block in styles.css. See docs/ui-styleguide.md.
//
// It enforces:
//   1. .jsx must not contain raw hex colors     → use var(--x) / theme.js instead   [ERROR]
//   2. styles.css hex (outside token blocks) that EXACTLY equals a token → var(--x)  [ERROR]
//   3. theme.js must contain no hex except the registered chart-only extras         [ERROR]
//   4. any hex that is a NEAR-duplicate of a token (drift) → unify it             [WARN]
//   5. redundant fallback var(--x, #hex) where #hex == --x's value               [WARN]
//   6. raw <input type="checkbox"> is banned → <Toggle>                           [ERROR]
//   7. a literal rgba(r,g,b,…) whose triplet is a themed colour → rgba(var(--x-rgb), a) [ERROR]
//   8. theme presets (`:root[data-theme="x"]` blocks) redeclare EXACTLY the themed
//      token set, their *-rgb triplets match their colours, and their text colours
//      hold WCAG contrast on their surfaces                                       [ERROR]
//
// Exit code is non-zero only on ERRORs, so it is safe as a CI gate. Run: npm run lint:style

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const CSS = join(SRC, 'styles.css')
const THEME = join(SRC, 'theme.js')

// Chart-only hues that legitimately have no UI token (validated categorical series +
// the reference-line hairline). They live in theme.js and nowhere else. Keep this list
// in sync with theme.js — a new chart-only color must be added here on purpose.
const CHART_EXTRAS = new Set(
  ['#4a90d9', '#b88a2f', '#3aa568', '#a878e0', '#12a89a', '#cc7a2f', '#cf68a8', '#464b5c', '#e8615f'].map(norm),
)

// Tokens a theme preset never touches: game semantics, the alert family, and everything that
// isn't colour. A preset must redeclare every OTHER token in :root — a missing one silently
// falls through to the default theme, which no human spots on screen.
const NEVER_THEMED = new Set([
  '--afk', '--offline',
  '--rarity-normal', '--rarity-magic', '--rarity-rare', '--rarity-unique', '--rarity-gem', '--rarity-currency',
  '--radius', '--radius-lg', '--shadow-1', '--shadow-2', '--ease', '--font', '--card-gradient', '--glow-gold',
])
// The channel triplets that must equal their colour token, per block.
const RGB_PAIRS = [['--accent-rgb', '--gold'], ['--gain-rgb', '--gain'], ['--loss-rgb', '--loss'], ['--live-rgb', '--live'], ['--digest-rgb', '--digest']]
// WCAG: [foreground, background, minimum ratio]. 4.5 = AA body text; 7 = AAA for the primary ink.
const CONTRAST = [
  ['--ink', '--panel', 7], ['--ink', '--bg', 7], ['--ink-2', '--panel', 4.5], ['--muted', '--panel', 4.5], ['--muted', '--bg', 4.5],
  ['--gold', '--panel', 4.5], ['--gain', '--panel', 4.5], ['--loss', '--panel', 4.5],
  ['--live', '--panel', 4.5], ['--digest', '--panel', 4.5], ['--recipe', '--panel', 4.5], ['--ink-on-gold', '--gold', 4.5],
]

const NEAR_THRESHOLD = 12 // RGB Euclidean distance below which two colors are "the same, drifted"

const HEX = /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/g
const RGBA = /rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*[,)]/g

// Escape hatch: a line carrying `style-ok` (in a comment) is a deliberate exception —
// a genuinely one-off color with no token. Use sparingly and explain why on the line.
const OK = /style-ok/
let errors = 0
let warns = 0
const err = (file, line, msg, src = '') => { if (OK.test(src)) return; errors++; console.log(`  ✖ ${file}:${line}  ${msg}`) }
const warn = (file, line, msg, src = '') => { if (OK.test(src)) return; warns++; console.log(`  ⚠ ${file}:${line}  ${msg}`) }

function norm(hex) {
  let h = hex.toLowerCase()
  if (h.length === 4) h = '#' + [...h.slice(1)].map(c => c + c).join('')
  return h
}
function rgb(hex) {
  const h = norm(hex)
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}
function dist(a, b) {
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b)
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2)
}
function luminance(hex) {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const [r, g, b] = rgb(hex)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// ---- Parse every token block: `:root {` is the source of truth (the default theme);
//      `:root[data-theme="x"] {` blocks are presets that override it. ----
const cssText = readFileSync(CSS, 'utf8')
const cssLines = cssText.split('\n')
const blocks = []   // { name, start, end, tokens: Map(--name → value), line: Map(--name → lineNo) }
for (let i = 0; i < cssLines.length; i++) {
  const m = cssLines[i].match(/^\s*:root(\[data-theme="([a-z0-9-]+)"\])?\s*\{/)
  if (!m) continue
  const end = cssLines.findIndex((l, j) => j > i && l.includes('}'))
  if (end === -1) { console.error(`Unterminated token block at styles.css:${i + 1}`); process.exit(2) }
  const tokens = new Map(), line = new Map()
  for (let j = i + 1; j < end; j++) {
    for (const t of cssLines[j].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) { tokens.set(t[1], t[2].trim()); line.set(t[1], j + 1) }
  }
  blocks.push({ name: m[2] || 'root', start: i, end, tokens, line })
}
const root = blocks.find(b => b.name === 'root')
if (!root) { console.error('Could not locate :root block in styles.css'); process.exit(2) }
const inTokenBlock = (i) => blocks.some(b => i > b.start && i < b.end)

const tokenValue = root.tokens         // --name → raw value string (default theme)
const tokenByHex = new Map()           // normalized hex → --name  (color tokens only)
for (const [name, v] of tokenValue) {
  const hexes = v.match(HEX)
  if (hexes && hexes.length === 1 && v === hexes[0]) tokenByHex.set(norm(hexes[0]), name)
}
// Themed colours' channel triplets, for check 7: "212,172,82" → --accent-rgb
const tripletToken = new Map()
for (const [name, v] of tokenValue) if (name.endsWith('-rgb')) tripletToken.set(v.replace(/\s+/g, ''), name)

const nearestToken = (hex) => {
  let best = null, bd = Infinity
  for (const [h, name] of tokenByHex) { const d = dist(hex, h); if (d < bd) { bd = d; best = { name, hex: h, d } } }
  return best
}

// ---- Checks 1, 6: .jsx has no raw hex and no raw checkboxes. ----
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { walk(p); continue }
    if (!p.endsWith('.jsx')) continue
    const rel = relative(ROOT, p)
    readFileSync(p, 'utf8').split('\n').forEach((ln, i) => {
      for (const raw of ln.match(HEX) || []) {
        const hex = norm(raw)
        const tok = tokenByHex.get(hex)
        if (tok) err(rel, i + 1, `raw hex ${raw} == var(${tok}) — use the token, don't paste the hex`, ln)
        else {
          const n = nearestToken(hex)
          const hint = n && n.d < NEAR_THRESHOLD ? ` (near var(${n.name}) ${n.hex} — likely the same color, drifted)` : ''
          err(rel, i + 1, `raw hex ${raw} in JSX — colors belong in styles.css tokens / theme.js, not inline${hint}`, ln)
        }
      }
      if (/type\s*=\s*["']checkbox["']/.test(ln)) err(rel, i + 1, 'raw <input type="checkbox"> is banned — use <Toggle> (components/Toggle.jsx)', ln)
    })
  }
}
walk(SRC)

// ---- Check 3: theme.js is var() aliases; the only hex allowed is the chart-only extras. ----
readFileSync(THEME, 'utf8').split('\n').forEach((ln, i) => {
  for (const raw of ln.match(HEX) || []) {
    const hex = norm(raw)
    if (CHART_EXTRAS.has(hex)) continue
    const tok = tokenByHex.get(hex)
    err('src/theme.js', i + 1, tok ? `hex ${raw} == var(${tok}) — theme.js aliases tokens as 'var(${tok})', it does not mirror hex` : `hex ${raw} is not a registered chart extra — theme.js carries no UI colours`, ln)
  }
})

// ---- Checks 2, 4, 5, 7: literals in styles.css outside the token blocks. ----
cssLines.forEach((ln, i) => {
  if (inTokenBlock(i)) return
  for (const m of ln.matchAll(HEX)) {
    const raw = m[0], hex = norm(raw)
    const tok = tokenByHex.get(hex)
    if (tok) {
      const fallback = new RegExp(`var\\(\\s*${tok}\\s*,\\s*${raw}\\s*\\)`, 'i')
      if (fallback.test(ln)) warn('src/styles.css', i + 1, `redundant fallback var(${tok}, ${raw}) — the fallback duplicates the token; drop it`, ln)
      else err('src/styles.css', i + 1, `raw hex ${raw} == var(${tok}) — use the token`, ln)
      continue
    }
    const n = nearestToken(hex)
    if (n && n.d < NEAR_THRESHOLD) warn('src/styles.css', i + 1, `${raw} is a near-duplicate of var(${n.name}) ${n.hex} — unify to the token`, ln)
  }
  for (const m of ln.matchAll(RGBA)) {
    const trip = `${m[1]},${m[2]},${m[3]}`
    const tok = tripletToken.get(trip)
    if (tok) err('src/styles.css', i + 1, `literal rgba(${trip},…) is the ${tok.replace('-rgb', '')} colour — use rgba(var(${tok}), a) so presets can change it`, ln)
  }
})

// ---- Check 8: presets. ----
const themedKeys = [...tokenValue.keys()].filter(k => !NEVER_THEMED.has(k))
for (const b of blocks) {
  if (b.name === 'root') continue
  const file = 'src/styles.css', at = b.start + 1
  const missing = themedKeys.filter(k => !b.tokens.has(k))
  const extra = [...b.tokens.keys()].filter(k => !tokenValue.has(k))
  const forbidden = [...b.tokens.keys()].filter(k => NEVER_THEMED.has(k))
  if (missing.length) err(file, at, `preset "${b.name}" is missing ${missing.length} token(s): ${missing.join(', ')} — a preset redeclares every themed token`)
  if (extra.length) err(file, at, `preset "${b.name}" declares tokens :root does not have: ${extra.join(', ')}`)
  if (forbidden.length) err(file, at, `preset "${b.name}" may not override ${forbidden.join(', ')} (never themed)`)
  const hexOf = (k) => { const v = b.tokens.get(k); const h = v && v.match(HEX); return h && h.length === 1 && v === h[0] ? norm(h[0]) : null }
  for (const [trip, col] of RGB_PAIRS) {
    const h = hexOf(col), t = b.tokens.get(trip)
    if (h && t && t.replace(/\s+/g, '') !== rgb(h).join(',')) err(file, b.line.get(trip), `preset "${b.name}": ${trip} is ${t} but ${col} is ${h} (${rgb(h).join(',')}) — keep the triplet equal to its colour`)
  }
  for (const [fg, bg, min] of CONTRAST) {
    const a = hexOf(fg), c = hexOf(bg)
    if (!a || !c) continue
    const r = contrast(a, c)
    if (r < min) err(file, b.line.get(fg), `preset "${b.name}": ${fg} ${a} on ${bg} ${c} is ${r.toFixed(2)}:1, needs ≥ ${min}:1`)
  }
}
// The default theme is held to the same contrast bar (it is the reference the presets copy).
for (const [fg, bg, min] of CONTRAST) {
  const a = tokenValue.get(fg), c = tokenValue.get(bg)
  if (!a || !c || !HEX.test(a) || !HEX.test(c)) { HEX.lastIndex = 0; continue }
  HEX.lastIndex = 0
  const r = contrast(a, c)
  if (r < min) err('src/styles.css', root.line.get(fg), `:root ${fg} ${a} on ${bg} ${c} is ${r.toFixed(2)}:1, needs ≥ ${min}:1`)
}

console.log('')
if (errors) { console.log(`✖ ${errors} error(s), ${warns} warning(s) — style tokens not respected. See docs/ui-styleguide.md`); process.exit(1) }
console.log(`✓ style tokens respected${warns ? ` (${warns} warning(s))` : ''}${blocks.length > 1 ? ` · ${blocks.length - 1} preset(s) checked` : ''}`)
