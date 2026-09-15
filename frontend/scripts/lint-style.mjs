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
//   1. .jsx must not contain raw hex colors     → import from theme.js instead   [ERROR]
//   2. styles.css hex (outside :root) that EXACTLY equals a token → use var(--x)  [ERROR]
//   3. theme.js hex must be a :root token value or a registered chart-only extra  [ERROR]
//   4. any hex that is a NEAR-duplicate of a token (drift) → unify it             [WARN]
//   5. redundant fallback var(--x, #hex) where #hex == --x's value               [WARN]
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
  ['#4a90d9', '#b88a2f', '#3aa568', '#a878e0', '#12a89a', '#cc7a2f', '#cf68a8', '#464b5c'].map(norm),
)

const NEAR_THRESHOLD = 12 // RGB Euclidean distance below which two colors are "the same, drifted"

const HEX = /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/g

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

// ---- Parse the :root token block: it is the single source of truth. ----
const cssText = readFileSync(CSS, 'utf8')
const cssLines = cssText.split('\n')
const rootStart = cssLines.findIndex(l => /:root\s*\{/.test(l))
const rootEnd = cssLines.findIndex((l, i) => i > rootStart && l.includes('}'))
if (rootStart === -1 || rootEnd === -1) { console.error('Could not locate :root block in styles.css'); process.exit(2) }

const tokenValue = new Map()        // --name → raw value string
const tokenByHex = new Map()        // normalized hex → --name  (color tokens only)
for (let i = rootStart + 1; i < rootEnd; i++) {
  const m = cssLines[i].match(/(--[a-z0-9-]+)\s*:\s*([^;]+);/i)
  if (!m) continue
  tokenValue.set(m[1], m[2].trim())
  const hexes = m[2].match(HEX)
  if (hexes && hexes.length === 1 && m[2].trim() === hexes[0]) tokenByHex.set(norm(hexes[0]), m[1])
}
const nearestToken = (hex) => {
  let best = null, bd = Infinity
  for (const [h, name] of tokenByHex) { const d = dist(hex, h); if (d < bd) { bd = d; best = { name, hex: h, d } } }
  return best
}

// ---- Check 1: no raw hex in .jsx (charts/inline styles import from theme.js). ----
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
        if (tok) err(rel, i + 1, `raw hex ${raw} == var(${tok}) — import it from theme.js, don't paste the hex`, ln)
        else {
          const n = nearestToken(hex)
          const hint = n && n.d < NEAR_THRESHOLD ? ` (near var(${n.name}) ${n.hex} — likely the same color, drifted)` : ''
          err(rel, i + 1, `raw hex ${raw} in JSX — colors belong in theme.js, not inline${hint}`, ln)
        }
      }
    })
  }
}
walk(SRC)

// ---- Check 3: theme.js hex must trace back to a token or a registered chart extra. ----
readFileSync(THEME, 'utf8').split('\n').forEach((ln, i) => {
  for (const raw of ln.match(HEX) || []) {
    const hex = norm(raw)
    if (tokenByHex.has(hex) || CHART_EXTRAS.has(hex)) continue
    const n = nearestToken(hex)
    const hint = n && n.d < NEAR_THRESHOLD ? ` — near var(${n.name}); mirror :root or fix the drift` : ' — add a :root token or register it in CHART_EXTRAS'
    err('src/theme.js', i + 1, `hex ${raw} is not a :root token value${hint}`, ln)
  }
})

// ---- Checks 2, 4, 5: hex in styles.css outside :root. ----
cssLines.forEach((ln, i) => {
  if (i > rootStart && i < rootEnd) return // skip the token definitions themselves
  for (const m of ln.matchAll(HEX)) {
    const raw = m[0], hex = norm(raw)
    const tok = tokenByHex.get(hex)
    if (tok) {
      // Check 5: redundant fallback var(--tok, #samevalue) reads as noise, not drift.
      const fallback = new RegExp(`var\\(\\s*${tok}\\s*,\\s*${raw}\\s*\\)`, 'i')
      if (fallback.test(ln)) warn('src/styles.css', i + 1, `redundant fallback var(${tok}, ${raw}) — the fallback duplicates the token; drop it`, ln)
      else err('src/styles.css', i + 1, `raw hex ${raw} == var(${tok}) — use the token`, ln)
      continue
    }
    // Check 4: near-duplicate of a token → drift (e.g. a stale wrong fallback).
    const n = nearestToken(hex)
    if (n && n.d < NEAR_THRESHOLD) warn('src/styles.css', i + 1, `${raw} is a near-duplicate of var(${n.name}) ${n.hex} — unify to the token`, ln)
  }
})

console.log('')
if (errors) { console.log(`✖ ${errors} error(s), ${warns} warning(s) — style tokens not respected. See docs/ui-styleguide.md`); process.exit(1) }
console.log(`✓ style tokens respected${warns ? ` (${warns} warning(s))` : ''}`)
