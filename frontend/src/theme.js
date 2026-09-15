// Arbiter design tokens, for JavaScript consumers.
//
// CSS reads these tokens from the `:root` block in styles.css via `var(--x)`. But
// SVG/canvas libraries (Recharts) take color as plain string PROPS, not CSS — they
// can't see `var(--muted)`. This module is the sanctioned home for those colors so
// charts and inline styles reference the SAME palette the stylesheet does, instead
// of pasting ad-hoc hexes (which is how we ended up with two different "muted" grays).
//
// SINGLE SOURCE OF TRUTH: every hex here MUST equal a token defined in
// styles.css `:root`. `npm run lint:style` fails the build if they drift apart —
// so change a color in ONE place (`:root`) and mirror it here, never fork it.
// See docs/ui-styleguide.md.

export const color = {
  bg: '#0f1116',
  bg2: '#14171e',
  panel: '#1b1f28',
  panel2: '#222734',
  panelHi: '#2a303f',
  line: '#2b3040',
  lineStrong: '#3a4152',
  ink: '#ece8dd',
  ink2: '#c8c4b8',
  muted: '#8b91a1',
  gold: '#d4ac52',
  gold2: '#e7c56b',
  goldDim: '#6b5722',
  gain: '#6fce9f',
  loss: '#e07a68',
  live: '#7fb4d9',
  digest: '#b39ddb',
  recipe: '#e0b866',
}

// Player-presence tri-state, used by both PingButton (JS) and the `.pb-dot` CSS rules.
// online reuses --gain; afk/offline are their own status tokens (--afk/--offline in :root).
export const presence = {
  online: color.gain,   // #6fce9f
  afk: '#e0a83a',       // amber   → --afk
  offline: '#e8615f',   // alert red → --offline (distinct from --loss; see the "red family")
}

// Categorical series palette for multi-line/multi-series charts (InflationView).
// Assigned in FIXED ORDER — never cycled, never regenerated per render — so a given
// entity keeps its color across filters (per the dataviz non-negotiables).
//
// These are chart-only hues, distinct from the UI tokens on purpose: they were
// VALIDATED colorblind-safe against the dark surface (OKLCH lightness band + chroma
// floor + CVD/normal ΔE) with the dataviz palette validator. Do NOT hand-edit a value
// to "match the UI" — re-run the validator if you must change one, or you silently
// break CVD separation. Registered as chart-scoped in the linter (CHART_EXTRAS).
export const series = ['#4a90d9', '#b88a2f', '#3aa568', '#a878e0', '#e8615f', '#12a89a', '#cc7a2f', '#cf68a8']

// Shared Recharts chrome, so every chart's axes/grid/tooltip match the app surfaces
// (and match the CSS `.chart-tip` custom tooltip: --panel-2 bg, --line-strong border).
export const chart = {
  axis: color.muted,          // axis tick labels  → --muted
  grid: color.line,           // cartesian grid    → --line
  refLine: '#464b5c',         // reference-line hairline (chart-only, no UI token)
  cursor: color.gold,         // hover cursor line → --gold
  tooltipBg: color.panel2,    // tooltip surface   → --panel-2
  tooltipBorder: color.lineStrong, // tooltip border → --line-strong
}
