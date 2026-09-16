# Arbiter UI styleguide

The visual contract for the Arbiter frontend (`frontend/`). It documents the design
system **as actually built** — every rule here is drawn from `src/styles.css` and the
components, not aspiration. New UI must fit this system; `npm run lint:style` enforces
the parts that can be checked automatically (see [Enforcement](#enforcement)).

The look is a **dark, tactile "vault" theme**: deep slate surfaces, a single gold accent,
IBM Plex Sans with tabular figures, hairline borders, soft shadows, and restrained gold
glow on elevation. Numbers are first-class — this is a trading dashboard.

---

## 1. Architecture

- **One hand-authored stylesheet:** `src/styles.css`. No Tailwind, no CSS-in-JS, no CSS
  modules, no preprocessor. It is organized into commented sections (`/* ---------- top bar ---------- */`).
- **Design tokens are CSS custom properties** in the `:root` block at the top of
  `styles.css`. That block is the **single source of truth** for color/space/shape/motion.
- **`src/theme.js` is the JavaScript mirror** of the color tokens. SVG/canvas libraries
  (Recharts) take color as string *props* and can't read `var(--x)`, so JS consumers
  import from `theme.js` instead of pasting hexes. Every hex in `theme.js` must equal a
  `:root` token value or a registered chart-only extra — the linter enforces this.
- **Class names are flat and semantic**, loosely BEM-ish: a block (`.price-tile`),
  elements as `.pt-name` / `.pt-chg` / `.pt-src`, and state as modifier classes
  (`.price-tile.src-live`, `.btn.primary`, `.seg-btn.on`, `.tabs button[aria-selected]`).
  No utility classes, no deep nesting.

### When inline `style={}` is allowed

Inline styles exist in the codebase and are fine for **dynamic or layout-only** values —
a computed width, a `height: 360`, a `gridTemplateColumns` built at runtime. They are
**never** allowed for color: a color in an inline style or a Recharts prop must come from
`theme.js`. (This is the single rule that most often drifts — it's why the linter exists.)

---

## 2. Tokens

### Surfaces (dark → light)

| Token | Hex | Use |
|---|---|---|
| `--bg` | `#0f1116` | app background (under the radial-gradient body wash) |
| `--bg-2` | `#14171e` | input fields, deepest insets |
| `--surface-1` | `#16181d` | resting cards on the app bg (ping-card, ws-rail) |
| `--panel` | `#1b1f28` | primary panel surface, rail, table hover |
| `--surface-pop` | `#1c212c` | floating popovers (command palette, currency picker) |
| `--panel-2` | `#222734` | secondary/button surface, chart tooltip bg |
| `--panel-hi` | `#2a303f` | top of card gradients, hover panels |

Cards use a signature elevated recipe: `linear-gradient(165deg, var(--panel-hi) -20%, var(--panel) 45%)`
plus `var(--shadow-1)`. Near-black one-offs below `--bg` (embedded webview backdrops) are
deliberate and marked `/* style-ok */`.

### Lines & ink

| Token | Hex | Use |
|---|---|---|
| `--line` | `#2b3040` | hairline borders, table row dividers, grid |
| `--line-strong` | `#3a4152` | input borders, stronger dividers, tooltip border |
| `--ink` | `#ece8dd` | primary text (warm off-white) |
| `--ink-2` | `#c8c4b8` | secondary text, section headings, emphasized `<b>` |
| `--muted` | `#8b91a1` | labels, hints, axis text, resting tab text |

### Accent — gold (the one brand color)

| Token | Hex | Use |
|---|---|---|
| `--gold` | `#d4ac52` | brand accent, focus ring, active underline, primary buttons |
| `--gold-2` | `#e7c56b` | lighter gold for gradients & highlights |
| `--gold-dim` | `#6b5722` | dim gold — input focus border, bar fills |

Gold is used sparingly and always means "primary / brand / selected / hold." Don't
introduce a second accent hue; a new categorical need is a **chart series** color (§7),
not a UI accent.

### Semantic status

| Token | Hex | Meaning |
|---|---|---|
| `--gain` | `#6fce9f` | up / profit / online / success |
| `--loss` | `#e07a68` | down / loss / error tint |
| `--afk` | `#e0a83a` | player AFK (presence amber) |
| `--offline` | `#e8615f` | player offline / live alert (badges, hot teleport) |
| `--live` | `#7fb4d9` | data sourced from the **live** feed |
| `--digest` | `#b39ddb` | data sourced from the **digest** feed |
| `--recipe` | `#e0b866` | recipe/craft hops |

**The red family** is intentional, not drift — keep these distinct: `--loss` (financial
down), `--offline` (alert/offline), `#c8403e` (whisper-hot gradient partner), `#e83c3c`
(corrupted-vaal orb), `#e06b6b` (update error). Each has one job; don't collapse them.

`--live` / `--digest` / `--recipe` are **provenance** colors: they tag where a number came
from (a 2px left border on tiles, a dot in the loop, a source pill). Reuse them only for
provenance, never as decoration.

### Shape, elevation, motion, type

| Token | Value | Use |
|---|---|---|
| `--radius` | `6px` | default corner (buttons, inputs, chips) |
| `--radius-lg` | `12px` | cards, tiles, chart boxes |
| — | `999px` | pills (chips, download CTA, source pills) |
| `--shadow-1` | `0 1px 2px rgba(0,0,0,.35)` | resting card elevation |
| `--shadow-2` | `0 10px 34px rgba(0,0,0,.5)` | floating/modal elevation |
| `--glow-gold` | gold ring + halo | hover on tiles, modal borders |
| `--ease` | `cubic-bezier(.22,.61,.36,1)` | **the** app easing curve — use for all transitions |
| `--font` | IBM Plex Sans stack | everything; body sets `font-variant-numeric: tabular-nums` |

---

## 3. Typography

- **Family:** `--font` (IBM Plex Sans → Segoe UI → system). Base `14px`, line-height `1.45`.
- **Tabular numerals globally** (`font-variant-numeric: tabular-nums`) so figures don't
  jitter as they tick. Preserve this on anything numeric.
- **Scale in use:** h1 `16px/700`; section h2 `13px/600` in `--ink-2`; big stats `27px`
  (`.stat-val`), tile price `25px` (`.pt-mid`), detail price `34px` (`.cd-price`); labels
  `10–12px`. Don't invent new sizes — reach for an existing one.
- **Uppercase micro-labels:** `font-size: 10–11px; text-transform: uppercase; letter-spacing: .05–.08em`
  in `--muted` (see `.pulse-group-label`, `.pulse-label`, `.live-recent-head`). This is the
  house style for group/section labels.
- **Negative letter-spacing** (`-.01em`/`-.02em`) on large numbers only, for density.

---

### Wealth — the one display rule for amounts

Every amount of wealth is computed and stored in the **reference currency** (exalted by default;
`/api/*` payloads carry `*_ref`, `value_ex`, `medvol`, … in it). That baseline is what makes
worth comparable. On screen, big numbers stop meaning anything, so the display layer
re-denominates: **≥1,000,000 ref → mirrors, ≥1,000 ref → divines, ≥100 ref → chaos**, else the
reference. The rule lives in ONE place — `WEALTH_TIERS` + `wealthUnit()` in
`frontend/src/lib/wealth.js` — and every wealth figure renders through
`<Wealth v={amount} />` (`frontend/src/components/Wealth.jsx`: value + currency icon, raw
reference amount on hover) or `wealthText()` for tooltips. Prices come from `/api/status →
wealth_prices` (reference per unit), so the conversion follows the live market. Never format a
wealth amount with `fmt.n(x) <Cur/>` by hand — add the site to `<Wealth>` instead.

## 4. Color usage rules

1. **Never write a raw hex that a token already names.** Use `var(--token)` (CSS) or the
   `theme.js` export (JS). The linter fails the build on exact-duplicates.
2. **Text uses ink tokens** (`--ink` / `--ink-2` / `--muted`), never a status/series color.
   A colored *mark* (dot, bar, pill) carries identity next to neutral text — color is never
   the only signal (also an icon, label, or position). This mirrors the dataviz rule.
3. **Gain/loss are paired and consistent:** green up, red down, everywhere (`.gain`/`.loss`
   utility classes, `.pt-chg.gain/.loss`, flash animations). Don't swap or re-hue them.
4. **Provenance colors** (`--live`/`--digest`/`--recipe`) only ever indicate source.
5. **One accent.** Selection, focus, primary action, and "hold" are all gold. Resist adding
   a competing accent — if you need more categories, they're chart series, not chrome.

---

## 5. Component patterns

Reuse these before writing new CSS. Each is a small, composable block already in `styles.css`.

- **Buttons — `.btn`** (`.btn.primary` gold gradient, `.btn.small`, `:disabled` at .5). Base
  is `--panel-2` + `--line-strong`, hover lifts to `--panel-hi` with a gold-dim border,
  `:active` nudges `translateY(1px)`.
- **Segmented control — `.seg` / `.seg-btn`** (`.on` = gold gradient). For 2–4 mutually
  exclusive options (time horizons, modes).
- **Toggle switch — `<Toggle>`** (`components/Toggle.jsx`, `.toggle`/`.toggle-track`/`.toggle-thumb`).
  The **only** on/off control. **Raw `<input type="checkbox">` is BANNED** and fails
  `npm run lint:style`. `onChange` receives the new boolean; pass a `label` for the inline text.
- **Refresh — `<RefreshButton>`** (icon-only, spins on activation). No "Refresh"/"Live" text.
- **Currency selection — `<CurrencyPicker>`** (progressive-search combobox). Use it for **every**
  currency/anchor field — never a raw `<select>` of currencies. `value`/`onChange` are the id.
- **Chips (pill family):** `.cmdk-chip`, `.ver-chip`, `.pulse-chip`, `.update-chip`
  (`.busy`/`.ready`/`.ok`/`.err`), `.download-app`. All `border-radius: 999px`, inline-flex,
  small gap, `--muted`→`--ink` on hover. Status chips add an icon + label, never color alone.
- **Tiles & cards:** `.price-tile` (the card gradient + `::before` top sheen + gold-glow
  hover + `.src-live`/`.src-digest` left border), `.card-detail` (the modal it morphs into
  via shared `layoutId`), `.capcard`, `.chart-box`, `.infl-stats .stat`. All share the
  165deg gradient + `--radius-lg` + `--shadow-1`.
- **Forms — `.field`** (grid label+control, `--muted` label). Inputs sit on `--bg` with a
  `--line-strong` border and get the **gold focus ring** (`box-shadow: 0 0 0 3px rgba(212,172,82,.12)`
  + `--gold-dim` border). Keep that ring on any new input/select/textarea.
- **Tabs — `.tabs` / `.subtabs`** with an animated `.tab-underline` (gold gradient, driven
  by `motion`), `aria-selected="true"` = `--ink`. Sub-navigation uses `.subtabs`, not new pages.
- **Tables:** `<th>` muted 12.5px; `.num` cells right-aligned; `th.sortable`/`th.sorted`;
  row hover tints gold at 5%. Financial tables inherit tabular figures automatically.
- **Feedback:** `.toast` (bottom-right, left-border status color), `.notice`/`.error`
  (left-border callout), `.hint`/`.warn-hint`, `.empty` state, `.dot`/`.dot.ok/.stale/.off`
  status dot with pulse.
- **Currency — `<Cur>` / `.cur`**: the canonical way to render a currency (icon + name),
  ellipsis-safe. Don't render currency icons ad hoc.

---

## 6. Motion

- **Every transition uses `--ease`** and a short duration: `.12s` micro-interactions,
  `.15s` hover color, `.18s` tile elevation.
- **Keyframe catalog** (reuse, don't reinvent): `spin` (loaders, cold-backfill orb),
  `shimmer` (skeletons), `dot-pulse` / `chip-pulse` (status heartbeat), `flash-gain` /
  `flash-loss` (price ticks), `dl-bob`, the `vaal-*` set (alert orb intensity).
- **Reduced motion is mandatory.** A global `@media (prefers-reduced-motion: reduce)` kills
  transitions, and animation-heavy elements each add their own reduce override. **Any new
  animation must ship a `prefers-reduced-motion` fallback** (stop it or make it static).
- Prefer **state-driven** animation (class toggles, the `motion` lib, WAAPI) over rAF loops.
  Note: in a hidden/automation tab, animations freeze mid-flight — verify settled UI with
  `getAnimations().finish()`, don't assume a frame ran.

---

## 7. Charts (Recharts)

- **Import colors from `theme.js`** — `color`, `series`, `chart`. Never a hex in chart JSX.
  `chart.axis/grid/refLine/cursor/tooltipBg/tooltipBorder` keep every chart's chrome aligned
  with the app surfaces (and with the CSS `.chart-tip` tooltip).
- **`series` is a fixed-order categorical palette**, assigned by index and **never cycled**
  or regenerated per render, so an entity keeps its color across filters. It was **validated
  colorblind-safe** against the dark surface (OKLCH lightness band + chroma floor + CVD/normal
  ΔE) with the dataviz validator. Don't hand-edit a value to "match the UI" — re-run the
  validator, or you silently break CVD separation. Chart-only hues live only in `theme.js`
  and are registered in the linter's `CHART_EXTRAS`.
- **Identity is never color-alone:** a legend is always present for ≥2 series; ≤4 may also be
  direct-labeled. One axis per chart (no dual y-scales).

---

## 8. Accessibility

- **Focus:** global `:focus-visible { outline: 2px solid var(--gold) }`; inputs use the gold
  ring. Never remove focus styling without an equivalent replacement.
- **Semantics:** tabs use `aria-selected`; expandable rows use `aria-expanded`. Keep them.
- **Contrast:** ink tokens on the surface tokens are the tested pairs — stay within them.
  A contrast-marginal color obligates a visible label, not just the color.
- **Reduced motion:** see §6.

---

## 9. Enforcement

`frontend/scripts/lint-style.mjs` — a **zero-dependency** Node checker. Its source of truth
is the `:root` block in `styles.css`; it covers **both** `.css` and `.jsx` (which stylelint
can't — the worst drift lived in Recharts props). Run it:

```bash
cd frontend && npm run lint:style
```

It runs in CI on any `frontend/src/**` change (`.github/workflows/lint-style.yml`) and has
**no install step** (stdlib only).

**Errors (fail the build):**
- a raw hex in `.jsx` (colors belong in `theme.js`);
- a hex in `styles.css` outside `:root` that **exactly equals** a token (use `var(--x)`);
- a hex in `theme.js` that isn't a `:root` token value or a registered `CHART_EXTRAS` entry
  (catches `theme.js` ↔ `:root` drift).

**Warnings (guidance, don't fail):**
- a hex that is a **near-duplicate** of a token (RGB distance < 12) — e.g. a second slightly
  different "muted" grey. Fix by unifying to the token.
- a redundant `var(--x, #samevalue)` fallback — drop the fallback.

**Escape hatch:** append `/* style-ok: reason */` (CSS) or `// style-ok: reason` (JS) to a
line for a genuine one-off color that has no token (e.g. the near-black webview backdrop).
Use it rarely and always say why.

### Adding or changing a color

1. Add/point to a token in the `:root` block of `styles.css`, named **semantically**
   (by role, not by hue — `--offline`, not `--red-2`).
2. If JavaScript needs it (charts, inline styles), mirror it in `theme.js`.
3. Reference it with `var(--token)` / the `theme.js` export — never paste the hex.
4. `npm run lint:style` must pass.

---

## 10. Quick "don'ts"

- ❌ Raw hex in JSX or a Recharts prop → import from `theme.js`.
- ❌ A near-duplicate of an existing token → reuse the token.
- ❌ A new page for a feature → prefer a sub-tab, badge, or inbox entry (see the ecosystem
  section in [`../CLAUDE.md`](../CLAUDE.md)).
- ❌ A new accent hue → gold is the only accent; extra categories are chart series.
- ❌ An animation without a `prefers-reduced-motion` fallback.
- ❌ Color as the only signal → pair with icon/label/position.
- ❌ A new font size when an existing step fits.
