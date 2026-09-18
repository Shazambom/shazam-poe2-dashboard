// Arbiter design tokens, for JavaScript consumers.
//
// CSS reads the tokens from the `:root` block in styles.css via `var(--x)`. Recharts and
// inline styles take colour as plain string PROPS — but the browser resolves `var(--x)`
// in SVG presentation attributes and inline styles too, so this module hands JS consumers
// the SAME variable the stylesheet uses. Nothing here is a hex copy that can drift, and a
// theme preset (a `:root[data-theme]` block) re-colours charts and CSS alike at paint time.
//
// The one exception is the chart `series` palette, which is chart-only and never themed
// (validated colorblind-safe once; see below). `npm run lint:style` enforces that this file
// carries no other hex. See docs/ui-styleguide.md.

const v = (name) => `var(--${name})`

export const color = {
  bg: v('bg'),
  bg2: v('bg-2'),
  panel: v('panel'),
  panel2: v('panel-2'),
  panelHi: v('panel-hi'),
  line: v('line'),
  lineStrong: v('line-strong'),
  ink: v('ink'),
  ink2: v('ink-2'),
  muted: v('muted'),
  gold: v('gold'),
  gold2: v('gold-2'),
  goldDim: v('gold-dim'),
  gain: v('gain'),
  loss: v('loss'),
  live: v('live'),
  digest: v('digest'),
  recipe: v('recipe'),
}

// Item rarity (item cards / sale rows) — the --rarity-* tokens; game semantics, never themed.
export const rarity = { normal: v('rarity-normal'), magic: v('rarity-magic'), rare: v('rarity-rare'), unique: v('rarity-unique'), gem: v('rarity-gem'), currency: v('rarity-currency') }

// Player-presence tri-state, used by both PingButton (JS) and the `.pb-dot` CSS rules.
// online reuses --gain; afk/offline are their own status tokens (the alert family, never themed).
export const presence = {
  online: color.gain,
  afk: v('afk'),
  offline: v('offline'),
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
// Deliberately NOT themed: a screenshot stays comparable between users on any preset.
export const series = ['#4a90d9', '#b88a2f', '#3aa568', '#a878e0', '#e8615f', '#12a89a', '#cc7a2f', '#cf68a8']

// Shared Recharts chrome, so every chart's axes/grid/tooltip match the app surfaces
// (and match the CSS `.chart-tip` custom tooltip: --surface-pop bg, --line-strong border).
export const chart = {
  axis: color.muted,          // axis tick labels  → --muted
  grid: color.line,           // cartesian grid    → --line
  refLine: '#464b5c',         // reference-line hairline (chart-only, no UI token)
  cursor: color.gold,         // hover cursor line → --gold
  tooltipBg: color.panel2,    // tooltip surface   → --panel-2
  tooltipBorder: color.lineStrong, // tooltip border → --line-strong
}
