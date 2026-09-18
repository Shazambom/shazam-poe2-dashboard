# UI joy plan — theme presets + a polish pass

> Synthesized via `/arena` on 2026-09-18 (four candidates, one cross-judge; record at the end).
> Owner's ask: "I want it to be a joy to interact with. Maybe a themes preset is a good idea where we
> can have multiple themes. Use PoE2 characters as inspiration like the Arbiter of Ash and the Arbiter
> of Divinity. What pieces of UI can we polish up and refine?"
>
> Status: **BUILT on `dev` 2026-09-18 (awaiting owner review before commit)** — §0 cuts A1–A11, the token sweep + linter + `theme.js` aliases, motion honesty B1–B8, all five presets with the Settings Appearance row / ⌘K commands / Electron backdrop, and C2 (focus in/out of the detail), C3 (keyboard-reachable tile remove), C6 (⌘1–5), C7 (glyphs). Deferred on purpose (keep it simple): A12 tone curation (owner-taste call), C1 the `<CurrencyPicker>` swap inside tiles (needs a small variant), C3's roving tabindex, C5 chart skeletons, C9 the icon placeholder disc, C8 (already global). Originally: Every file:line below was verified against `dev` at `1c17c78`
> (0.2.62-beta.1) and will drift; treat them as pointers. The styleguide (`docs/ui-styleguide.md`)
> and CLAUDE.md §0 Restraint remain the contract; this plan only applies them.

The thesis, which all four candidates reached independently: Arbiter already *looks* good. What stops
it being a joy is (a) it **narrates itself** — counts, legends, methodology paragraphs, σ labels — so
the eye never rests; (b) a few **motion dishonesties** (every number counts up from zero on every tab
switch; prices "flash" when nothing moved; the route table re-sorts under the cursor); and (c) the
accent is **welded into 26 hard-coded `rgba(212,172,82,…)` literals**, so the app can only ever be one
colour. Fix (c) and themes fall out almost free. Fix (a) and (b) first, because they're cheaper and
they're the owner's own standing directive.

---

## 1. Theme presets

### 1.1 Mechanism — tokens stay the single source of truth; a preset is a second block of the same names

```css
/* styles.css — :root is the DEFAULT theme (Vault), unchanged in shape. */
:root {
  --bg: #0f1116; … --gold: #d4ac52; …
  --accent-rgb: 212,172,82;   /* NEW: the accent as channels, for every rgba() alpha use */
  --gain-rgb: 111,206,159;    /* NEW */
  --loss-rgb: 224,122,104;    /* NEW */
  --wash-rgb: 90,120,180;     /* NEW: the second body radial (styles.css:46-50) */
  --backdrop: #191b22;        /* NEW: the Electron pre-CSS twin of --bg (today a literal in main.js) */
}
/* Each preset redeclares the SAME key set — no new names, no partial blocks. Same file. */
:root[data-theme="ash"]      { --bg: …; --gold: …; --accent-rgb: …; … }
:root[data-theme="divinity"] { … }
:root[data-theme="sekhemas"] { … }
```

Nothing else in the stylesheet changes shape — every rule already reads `var(--x)`.

**The blocker (step 0, ships alone, zero visual change):** `styles.css` bakes the accent and status
hues into literals the linter never sees (it only matches `#hex`): `rgba(212,172,82` ×26 lines
(`::selection` :65, input focus ring :75, `--glow-gold` :38, body wash :47, `.cmdk` :123/:129,
`.price-tile:hover` :660, `.card-detail` border :674, divine-pulse :844, table hover…),
`rgba(111,206,159` ×7 (gain: dot-pulse, `.pt-chg.gain`, flash-gain), `rgba(224,122,104` ×3 (loss),
`rgba(201,162,74` ×6, plus `#fff`/`#d9d2c0` in the wordmark gradient (:108) and `#4b5265` on the
scrollbar thumb (:70). Switch `--gold` alone today and you get a gold-ringed, gold-glowing,
gold-selected app wearing a different accent on its buttons. Rewrite each as
`rgba(var(--accent-rgb), .12)` etc.; wordmark → `linear-gradient(180deg, var(--ink), var(--ink-2))`;
scrollbar → a `--line-hover` token. Mechanical, greppable, one commit. The `rgba(232,60,60` ×8 (Vaal
orb) stay literal — alert red is not themed (§1.4).

**Linter (`frontend/scripts/lint-style.mjs`) — required, ~50 lines total:**
1. Today it parses the **first** `:root {` to the **first** `}` (lines 65–66) as the token table and
   errors on any hex elsewhere in `styles.css` that equals a token — so a preset block redeclaring
   `--loss: #e07a68` would trip check 2. Change the parse step to collect **every** selector block
   whose declarations are all `--custom-props` as a token block; `:root` stays the canonical key set.
2. **Error if a preset block's key set ≠ `:root`'s** minus the never-themed tokens (§1.4). A missing
   token silently falls through to Vault — the one failure mode presets introduce that a human won't
   spot on screen.
3. **Error on a literal `rgba(r,g,b,…)` whose triplet equals a token's channels** → "use
   `rgba(var(--x-rgb), a)`". Closes the hole permanently. Also: error if `--accent-rgb` /
   `--gain-rgb` / `--loss-rgb` don't equal the channels of `--gold` / `--gain` / `--loss` in the same
   block (the triplet is a derived copy; keep it honest).
4. **WCAG contrast assertion per block** (stdlib sRGB→luminance, ~25 lines): `--ink` ≥ 7:1 and
   `--ink-2` ≥ 4.5:1 and `--muted` ≥ 4.5:1 on `--panel` and on `--bg`; `--gain`/`--loss` ≥ 4.5:1 on
   `--panel`; `--ink-on-gold` ≥ 4.5:1 on `--gold`. This is what makes a theme safe to add later
   without a designer in the room; it turns the ratio tables below into a build gate.
5. Checks 1/4/5 unchanged.

**`theme.js` becomes `var()` aliases, not a hex mirror.** Recharts renders DOM SVG, so `var(--x)`
resolves in presentation attributes and inline styles — already proven in-tree (`InflationView.jsx:70`
`activeDot={{ stroke: 'var(--panel)' }}`, `CardDetail.jsx:36` Spark, `LeagueArc.jsx:41-46`). So:

```js
const v = (n) => `var(--${n})`
export const color = { bg: v('bg'), panel: v('panel'), muted: v('muted'), gold: v('gold'), gain: v('gain'), … }
export const presence = { online: v('gain'), afk: v('afk'), offline: v('offline') }
export const chart = { axis: v('muted'), grid: v('line'), cursor: v('gold'), tooltipBg: v('panel-2'), tooltipBorder: v('line-strong'), refLine: '#464b5c' }
export const series = ['#4a90d9', …]   // unchanged, CVD-validated, NOT themed
```

Consumers are exactly `InflationView.jsx`, `MarketView.jsx`, `PingButton.jsx`; none does arithmetic
on the hex, so a `var()` string is a drop-in. **This is the only mechanism that works without
re-plumbing the charts**: `InflationView.jsx:12-14` (`AXIS`, `GRID`, `CURSOR`) and
`MarketView.jsx:11-12` (`AXIS`, `TIP`) capture `chart.*` into **module-level constants at import**,
so any "read computed style at runtime" design (getters, a `readTokens()` resolver, mutating the
exported objects) leaves axes, grid, cursor and tooltip stuck on Vault. With `var()` strings the
browser resolves them at paint, every time. Linter check 3 flips to its stricter form: **theme.js
may contain no hex except `CHART_EXTRAS`** (`series` + `refLine`); the drift class check 3 was
written for disappears rather than being policed.

### 1.2 Where the choice lives, and how it's applied without a flash

Three tiers, one owner:

1. **Truth: `settings.theme`** — add `"theme": "vault"` to `DEFAULTS` in `backend/app/settings.py`
   and to the `payload()` whitelist in `SettingsView.jsx:24`. It's a user preference → `user.sqlite`,
   survives reinstall, follows the web test env. Saved via the existing
   `useStatus.getState().saveSettings({ theme })`.
2. **Boot mirror: `localStorage['arbiter.theme.v1']`**, read *synchronously* at the top of
   `frontend/src/main.jsx` before `createRoot(...).render()` (precedent: `board.num.v1`,
   `BoardView.jsx:96`), so there is no gold-to-ember flash while `/api/settings` is in flight.
   `statusStore.ensureSettings()` reconciles a moment later; the DB wins.
3. **Electron backdrop: `desktop-settings.json`** — `BACKDROP` at `desktop/src/main.js:31` is painted
   into `backgroundColor` (`:577`) before any CSS exists. Make it a table keyed by theme id
   (`BACKDROPS.vault.window`, `.ash.window`, …; each a `style-ok` twin of that theme's `--backdrop`;
   `trade` stays the shared near-black), read `theme` from the same JSON file `betaChannel` uses
   (`:27,33`), and add `setTheme(id)` to `preload.js` next to `setChannel`. Main writes the file
   **and calls `win.setBackgroundColor()` live**, so the resize gutter matches for the rest of the
   session, not just the next launch. The IPC carries an id, never a colour string. Loopback-only,
   contract intact.

```js
// frontend/src/lib/themeStore.js — zustand, matching horizonStore/syncStore. ~20 lines.
export const THEMES = [{ id: 'vault', name: 'Vault' }, { id: 'ash', name: 'Arbiter of Ash' },
                       { id: 'divinity', name: 'Arbiter of Divinity' }, { id: 'sekhemas', name: 'Trial of the Sekhemas' }]
export const applyTheme = (id) => {
  document.documentElement.dataset.theme = id === 'vault' ? '' : id
  try { localStorage.setItem('arbiter.theme.v1', id) } catch {}
  window.poe2desktop?.setTheme?.(id)
  useTheme.setState({ id })
  useStatus.getState().saveSettings({ theme: id })
}
```

**Choosing:** one **Appearance** panel in Settings (a `.seg` of the four names + a live swatch row:
surface / accent / gain / loss) above Notifications, plus a ⌘K command per theme
(`Theme: Arbiter of Ash`) through the `commands` list `App.jsx:130` already feeds the palette. No
topbar switcher (pressed four times ever, then sits there forever — exactly the control §0 says to
cut), no gallery, no hover-preview, no animated cross-fade. Instant swap; the app *is* the preview.

### 1.3 The presets — built from the owner's reference images (2026-09-18)

> **Hard rule (owner directive 2026-09-18): a preset changes colours and nothing else.** The palette
> canvas at https://claude.ai/artifact/H3tRSr8ruyXR8NABaySsXG is a *preview of colour* on a mock of
> the Board — it is not a UI design, and nothing from it may change how a component looks, lays out,
> moves or reads. The only UI-code changes theming may make are the ones in §1.1 that hook existing
> colours to the token contract. What varies per theme is a colour table. If a mock and the app
> disagree on anything but colour, the app wins.

**How each palette was derived.** One reference image per theme (the owner's picks: the Pinnacle of
Flame arena, the Arbiter of Divinity key art, Zarokh's arena, the Vaal temple key art), run through a
k-means extractor. The image's dominant midtone at its *real* saturation becomes the surfaces; its
brightest saturated light becomes the accent; its ambient glow becomes the wash; ink is the image's
light or dark extreme. First attempts that kept grey panels and only tinted the accent read as "Vault,
tinted" and were rejected. Every text-sized token below holds ≥ 4.5:1 on `--panel` (checked by
script; the linter in §1.1 #4 will enforce it).

**1. Vault** — today's theme, `:root`, unchanged. Slate + gold. Default.

**2. Arbiter of Ash** — *the Pinnacle of Flame: a baked burnt-ochre floor, black obsidian stone,
molten amber fire.* Reference clusters: `#793b17` / `#522914` (the floor, 35 %), `#080609` (void, 23 %),
`#c76337` (fire); 89 % of saturated pixels in 0–30°.

**Superseded 2026-09-18:** the owner retuned Ash in the custom theme builder and it was codified as
the shipped preset — night-navy stone (`--bg #131425`), ember-orange panels (`--panel #993905`),
white-hot ink, sulphur accent (`--gold #ffea05`), backdrop `#331f24`. The block in `styles.css` is
the source of truth; the table below is the original derivation from the reference image.

| token | value | note |
|---|---|---|
| `--bg` / `--bg-2` | `#0a0707` / `#150d0a` | the black void |
| `--panel` / `--panel-2` / `--panel-hi` / `--surface-pop` | `#2c1a12` / `#3a2216` / `#4a2816` / `#301c14` | the fire-lit floor, with its chroma (s≈40) |
| `--line` / `--line-strong` | `#4a2c1d` / `#63402a` | |
| `--ink` / `--ink-2` / `--muted` | `#f6e6d4` / `#dcbfa6` / `#b0937e` | 13.6 / 9.5 / 5.8 : 1 |
| `--gold` / `--gold-2` / `--gold-3` / `--gold-dim` | `#ff9a3c` / `#ffc470` / `#c9641e` / `#5c2d10` | molten amber, h28; 7.9:1 |
| `--ink-on-gold` | `#1f0f04` | 8.8:1 |
| `--gain` / `--loss` | `#7ccf9a` / `#ef5f55` | loss 5.1:1, ~25° off the accent |
| `--live` / `--digest` / `--recipe` | `#9cc6dd` / `#c6a2e0` / `#e9c98a` | `--recipe` is the pair to eyeball vs the accent |
| wash (`--wash-rgb`) / `--backdrop` | `138,61,20` rust / `#0f0a08` | |

**3. Arbiter of Divinity — the one LIGHT theme.** *The Origin Tower at noon: parchment sandstone,
bronze armour, wings of white-gold fire, amber sky.* A real 0.5.0 pinnacle boss (lightning aspect).
The owner's call: it is a daylight scene and does not translate to dark; a light preset is
acceptable because it is not the default and is a user preference. Reference clusters: `#f4dbb5` /
`#e1b795` / `#c0937a` (sand and light, 34 %), `#29201e` / `#4f3931` (bronze darks), brightest
`#f6d9b1` h34.

In light mode one colour cannot be both the text accent and a bright fill, so the *accent proper*
is a burnt bronze that passes as text, and the wing-fire lives in the tint, the glow and the wash.

| token | value | note |
|---|---|---|
| `--bg` / `--bg-2` | `#efd9b8` / `#e6cba5` | sand |
| `--panel` / `--panel-2` / `--panel-hi` / `--surface-pop` | `#f7e9cf` / `#ecd8b6` / `#fff6e3` / `#fbf1de` | parchment; `hi` is *lighter* so the card gradient reads sunlit |
| `--line` / `--line-strong` | `#d3b58c` / `#b8935f` | |
| `--ink` / `--ink-2` / `--muted` | `#2a1c14` / `#4f3931` / `#7a5f4d` | bronze darks; 13.7 / 8.9 / 4.9 : 1 |
| `--gold` / `--gold-2` / `--gold-3` | `#9a4f0f` / `#a8560f` / `#7a3d0a` | burnt bronze; 5.0:1 as text; the button gradient stays dark enough for pale ink |
| `--gold-dim` | `#f3c98a` | **inverted meaning: a bright fire tint**, not a dark fill — rename the token `--accent-soft` in the sweep so the name isn't a lie |
| `--ink-on-gold` | `#fff3dc` | 5.5:1 on `--gold` |
| `--gain` / `--loss` / `--afk` | `#1a6e42` / `#b8362a` / `#8a5f10` | darkened to hold ≥ 4.5:1 on light |
| `--live` / `--digest` / `--recipe` | `#2f6e9a` / `#6a4aa8` / `#8a5a10` | the dusty sky as `--live` |
| wash / `--backdrop` | `#f3c98a` at .55 + `#f0a040` at .30 / `#e9d2ae` | the amber light is most of the look |

Cost: this is a **medium** build, not a 30-line block. The app has dark-only assumptions that need a
light value: the `.price-tile::before` white sheen, the `.sk` shimmer, `--shadow-1/2`, icon
drop-shadows, and the near-black `style-ok` backdrops in `desktop/src/main.js`. Each becomes a token
or a `[data-theme="divinity"]` override — colour only, never a component change.

**4. Trial of the Sekhemas** — *Zarokh's arena: near-monochrome violet-grey stone, white-cyan
temporal light, gold rings, violet orbs.* Only 3 % of the reference's pixels are saturated; the stone
sits at h280–320 s1–4, the lights split cyan (180–210°) / gold (30°) / violet (240–330°). The set's
one cool theme.

| token | value | note |
|---|---|---|
| `--bg` / `--bg-2` | `#0a0a0c` / `#111114` | |
| `--panel` / `--panel-2` / `--panel-hi` / `--surface-pop` | `#1d1d22` / `#26262c` / `#33323a` / `#212126` | violet-grey stone |
| `--line` / `--line-strong` | `#34343c` / `#4a4954` | |
| `--ink` / `--ink-2` / `--muted` | `#f0ecf2` / `#c9c4cf` / `#928d9a` | 14.4 / 9.8 / 5.2 : 1 |
| `--gold` / `--gold-2` / `--gold-3` / `--gold-dim` | `#9be3f4` / `#c9f1fa` / `#4fb0c8` / `#1e4652` | white-cyan light, h191; 11.7:1 |
| `--ink-on-gold` | `#08222a` | 11.5:1 |
| `--gain` / `--loss` | `#7fd3aa` / `#ee7a7a` | |
| `--live` / `--digest` / `--recipe` | `#a99bea` violet (the orbs) / `#d7a0c8` / `#e6cf8e` (the gold rings) | accent 191° / live 250° / digest 316° — no two cool chips within 55° |
| wash / `--backdrop` | `90,74,122` violet / `#101012` | |

**5. Vaal** — *the temple: oxblood carved stone, brass trim, blood-red corruption light, the fleshy
rose of the eye and tentacles.* Reference clusters: `#341e1b` / `#522924` / `#783530` (stone, 54 %),
`#a92b2b` / `#d5423d` (the light), `#da8169`; 81 % of saturated pixels at 0°, 17 % at 330°.

| token | value | note |
|---|---|---|
| `--bg` / `--bg-2` | `#140b0a` / `#1c100e` | |
| `--panel` / `--panel-2` / `--panel-hi` / `--surface-pop` | `#2b1614` / `#3a1d1a` / `#4d2521` / `#311916` | oxblood |
| `--line` / `--line-strong` | `#4a2622` / `#68332c` | |
| `--ink` / `--ink-2` / `--muted` | `#f7e8de` / `#dcc0b3` / `#ae8b7f` | 14.3 / 10.0 / 5.5 : 1 |
| `--gold` / `--gold-2` / `--gold-3` / `--gold-dim` | `#f5738a` / `#ff9bb0` / `#c8385e` / `#5a1a2c` | the rose bloom, h349; 6.3:1 |
| `--ink-on-gold` | `#2a0810` | 6.8:1 |
| `--gain` / `--loss` | `#82d09c` / `#e65a4d` | **loss is blood**, 4.8:1, ~25° off the accent — the pair to eyeball |
| `--live` / `--digest` / `--recipe` | `#8fb8d8` / `#c3a2e2` / `#e0a34a` (the brass trim) | |
| wash / `--backdrop` | `176,42,42` blood, strong / `#160d0c` | |

Five is the cap. Ship order: Ash and Vaal (pure colour blocks), then Sekhemas, then Divinity (the
light-mode overrides).

### 1.4 Deliberately NOT themed

- **`series`** (the 8-hue CVD-validated chart palette, `theme.js:55`) — validated once against one
  surface; four themes = four re-validations and four chances to silently break colourblind
  separation, for zero trading value. Charts stay identical across themes (a screenshot stays
  comparable between users).
- **`--rarity-*`** — GGG's content colours. A Magic item is blue everywhere.
- **gain/loss *semantics*** — green up, red down, always. Themes may retune lightness for contrast
  and (Ash) rotate loss within the red family; never flip or leave the family.
- **The alert-red family and `--afk`**: `--offline`, the Vaal orb, `.btn.teleport.hot`, the ping
  banner, update-error. An alert looks the same in every world.
- **Provenance *roles*** — `--live` cool, `--digest` violet, `--recipe` warm. Retuned, never
  reassigned.
- **Everything that isn't colour**: `--radius`, `--shadow-*`, `--ease`, `--font`, the type scale,
  spacing, layout, iconography. No per-theme fonts, textures, boss art, background animation or
  sound packs — that's where theme systems go to die, and it fights the tabular-number density the
  app is built on.
- **`BACKDROP.trade`**, the embedded pathofexile.com webview, the CDN currency icons.
- **Light mode, except one.** Dark-first stays the default and the rule; Divinity is the single light preset (owner call, non-default, user preference). No second light theme.

---

## 2. Polish list

Ordered by group. §0 Restraint cuts first — every one of these *removes* pixels.

### A. Cut (the §0 debt already on screen)

| # | File | Today | Change | Why it's more joyful | Eff |
|---|---|---|---|---|---|
| A1 | `BoardView.jsx:247`, `:256` | `Price board · 21 currencies · each priced in its top market · 3d`; "N on board · hover a tile's × to remove" | Keep `Price board` + the range chip; delete both explanations | The one heading you read every session stops explaining itself | S |
| A2 | `HoldView.jsx:112–118`, `:146–150` | two 5-line methodology paragraphs under each table | Delete. Every fact is already a `title=` on the column it describes (`:84–88`); fold "low-confidence rows are thin markets" into the `Conf.` header tooltip; move the prose to `docs/` | The table ends at the table | S |
| A3 | `RoutesView.jsx:170–174` | `⊖ disenchant · ⊕ combine` legend + `searching… N found` | Delete both. Glyph meanings become `title`s in `RouteSteps.jsx`; streaming = a 2px indeterminate gold hairline under `<thead>` (reuse `.ws-progress`, which already has its reduced-motion override) | Loops appear; nothing narrates the search | S |
| A4 | `RoutesView.jsx:201–205` + `styles.css:491–496` | `≥2σ` band separator rows | **Keep the grouping** (real information design), drop the `≥Nσ` label — a 1px `--line` rule plus extra row gap | Ranking you can feel without a statistics lesson | S |
| A5 | `CardDetail.jsx:108–114`, `:119`, `:123` | signal chips `vol ×3.1` / `mp 0.42`; a `source` stat; a 2-line hub explainer | Keep `about to move` + `at <price>`; cut the two diagnostic chips; cut the `source` stat (the `pt-src` badge at `:99` already carries it with the same tooltip); cut the hub note (the ⬢ stat at `:121` has the tooltip) | The zoomed card becomes price → trend → what you'd get for it | S |
| A6 | `MarketView.jsx:52`, `:91–95`, `:102` | `{n} edges`, the VWAP explanation, the ranking hint | Delete; the explanation moves to `docs/` | — | S |
| A7 | `TradingSettings.jsx:63–64` | `EE2 detected · running · config OK · league X · builder ready` | Collapse to one `.dot` + `EE2 connected` / `not detected`; pipeline stages already go to beta telemetry | A setting, not a status board | S |
| A8 | `SettingsView.jsx:58` | a permanently reserved line reading `Changes save automatically.` | Delete the copy; keep the element as an invisible live-region that shows a transient gold `saved ✓` for 1.2 s | The page stops apologising for itself | S |
| A9 | `SettingsView.jsx:215–221` | connectivity sentence + a 260px `<pre>` JSON dump, always expanded inside Diagnostics | The `Copy` button is the feature; show three status dots and keep the JSON behind a nested `<details>` | Diagnostics stop being decor | S |
| A10 | `InflationView.jsx:164–168`, `:243–246`, `:279–282` | three explanatory paragraphs under the charts | Delete; the `stat-sub` lines and axis labels are the required context | — | S |
| A11 | `BoardView.jsx:110,118`, `App.jsx:142` (`surface()` with an `okText`) | "Saved"-style toasts on every autosave, stacking up to 4 | Stop toasting successes that the UI already confirms in place (A8's live-region, the board re-rendering); toast only failures and things the user can act on | Fewer interruptions | S |
| A12 | `lib/ping-sound.js:16–32` + `NotificationsPanel.jsx:44–49` | **17** tones in a `<select>`, twice (per family) | Curate to 6 (`soft1`, `soft3`, `chime`, `pop`, `bell`, `alert`); keep the other `.m4a` assets in `public/sounds` for now. Safe: `merge()` in `NotificationsPanel.jsx:73–76` already remaps a retired tone id to the family default, so no saved choice can go silent | Choosing a chime takes 2 s, not 17 auditions | S |

### B. Fix (motion honesty — these read as bugs even if nobody files them)

| # | File | Today | Change | Why | Eff |
|---|---|---|---|---|---|
| B1 | `BoardView.jsx:17–22` `AnimatedNumber` | `useSpring(0, …)` — **every tile counts up from zero on every tab switch** | `useSpring(value)` and set only on subsequent changes (`useRef` first-render guard) | The board *is* there when you arrive instead of assembling itself. Single highest joy-per-line change in the app | S |
| B2 | `BoardView.jsx:28–42` flash | `mid = r.mid / factor`, and the flash compares `mid` — so changing the "priced in" currency, or the numeraire's own price moving, flashes **every** tile green/red as if the market ticked | Compare `r.mid` (pre-repricing); shorten the flash to 600 ms | A flash means "this moved". Right now it lies | S |
| B3 | `BoardView.jsx:44` `Tile` | `layout` on all ~30 tiles → every 30-s poll re-measures the whole grid (visible micro-shuffle when nothing changed) | Drop `layout` from `Tile`; keep it on `.price-grid` for add/remove; keep the hover lift | The board stops twitching | S |
| B4 | `RoutesView.jsx:199–232` | SSE `routes` events append rows with no transition; provisional `scores` **re-sort the table under the cursor** mid-read | Freeze the sort while `streaming`; apply the authoritative order once on `done` (the backend already marks it); rows fade in over 120 ms | The single biggest "stop fighting me" fix in the app | M |
| B5 | `App.jsx:74` toasts | fixed timer; no hover-pause, no dismiss affordance | Pause on `pointerenter`, resume on leave; click dismisses | The ping banner's **Open** button currently escapes while you reach for it | S |
| B6 | `styles.css:62` + 10 per-rule media blocks | the global reduced-motion rule kills `transition` only; `animation` is killed piecemeal and misses `.streaming::after` (:774), the `.sk` variants and `chip-pulse` | One rule: `*, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important }`; delete the per-rule blocks | §6 of the styleguide becomes true rather than mostly-true | S |
| B7 | `App.jsx:171–172`, `:226–228`, `CardDetail`, `CommandPalette` | the `motion` springs (tab underline, toasts, modal scale, palette) ignore reduced-motion — the CSS rule cannot reach them | `useReducedMotion()` from `motion/react` → `transition={{ duration: 0 }}` | Same promise, kept for the JS half | S |
| B8 | `UpdateStatus.jsx` `.update-chip.ready` | pulses forever (`chip-pulse` infinite) | Pulse three times, then settle | A topbar element that never rests is fatigue, not delight | S |

### C. Refine (interaction)

| # | File | Today | Change | Why | Eff |
|---|---|---|---|---|---|
| C1 | `BoardView.jsx:73–75`, `CardDetail.jsx:152–155` | raw `<select>` of currencies — styleguide §5 mandates `<CurrencyPicker>` and bans exactly this | Swap in `<CurrencyPicker>` (a `small` variant: 24px box, 11px text; keep `stopPropagation` on the tile) | Searchable, keyboard-able, and *themable* — a native `<select>` on Windows renders OS chrome no theme can touch; it would be the one un-themed rectangle on screen | M |
| C2 | `CardDetail.jsx:87–90`, `CommandPalette.jsx` | Esc closes, but focus is never moved into the dialog nor restored to the opener | `useFocusTrap(ref)` in `lib/hooks.js` (~20 lines): focus the first control on open, cycle Tab inside, restore on close; `role="dialog" aria-modal` | Open a card with ⌘K, close it, keep typing — today your focus is gone | M |
| C3 | `BoardView.jsx` grid + `styles.css:700` | 30 tiles are 30 tab stops; `.pt-remove` is `opacity:0` until hover → unreachable by keyboard | Roving tabindex (one stop for the grid, arrows move, Enter opens, `Delete` removes with a 5-s undo toast); `.price-tile:focus-within .pt-remove { opacity: 1 }` | The board becomes drivable without the mouse | M |
| C4 | `BoardView.jsx:269` | empty state: *"No watched currencies yet — add some to the watchlist in Settings."* while a `<CurrencyPicker>` sits 12px above it | Put the picker **in** the empty state; delete the sentence. Same shape for `RoutesView:176–184` (`Reset filters` button) and `.live-empty` (`New search`) | An empty state that does the thing instead of describing where the thing is | S |
| C5 | `RoutesView.jsx` / `HoldView.jsx` first load | Board has shimmer skeletons (`:260–268`); Routes and Hold render nothing, then jump | Extract `<SkeletonRows n cols>` from the board's `.sk` recipe; use it in both tables and `SettingsView:48` / `CapitalCard:59` ("Loading…") | No layout jump anywhere; the shimmer already has its reduced-motion override | M |
| C6 | `App.jsx:77–83` | only ⌘K is bound | `⌘1`–`⌘5` for tabs, `/` focuses the palette, `?` opens a shortcut sheet rendered in the existing `.cmdk` surface | Discoverability with zero new default-screen pixels | M |
| C7 | `CommandPalette.jsx:68` | icon column mixes emoji (🏆 🔎) with glyphs (→ ⌘ ↗) | Two glyphs (`◆`, `⌕`) | Emoji render in colour, in a different font, in every theme | S |
| C8 | `lib/liveWiring.js:40` | `unlockSound()` is wired only for live pings | Hoist the unlock to `App.jsx` | The *signals* family isn't silent on a fresh window whose first gesture was elsewhere | S |
| C9 | `Cur.jsx` text fallback | plain span when the CDN icon fails/retries | a 14px round `--panel-2` disc behind the text | Rows keep their rhythm during the icon retry | S |
| C10 | `SubTabs.jsx`, `BrandOrb.jsx`, the ping-sound pipeline | already good | **Nothing.** Listed so nobody "improves" them. Do **not** add UI click/hover/success sounds: sound in Arbiter means "something happened while you weren't looking"; diluting that costs more than it gives | — | — |

---

## 3. Priority order

1. **The §0 cut pass (A1–A12).** All S, all deletions, no new abstractions, no theme dependency.
   The app gets quieter in an afternoon, it is the owner's own standing directive, and it shrinks the
   surface every later change has to keep working — including the four-times-over contrast tuning
   the presets would otherwise inherit. Highest joy per hour by a wide margin.
2. **De-hardcoding + linter (§1.1) + `theme.js` as `var()` aliases.** M. Ship it **with zero
   themes**: the linter proves Vault resolves to the same colours, and a CDP drive of Board /
   Strategy / Economy confirms nothing lost its glow. Even if no preset ever ships it pays for itself
   — the accent stops being 26 independent copies and a whole linter check becomes structurally
   unnecessary. Everything in §1.3 is then a ~30-line CSS block.
3. **Motion honesty (B1–B5).** S+S+S+M+S. B1 alone changes the felt quality of the most-visited
   screen; B2 stops the app crying wolf; B3 stops the twitch; B4 stops the table fighting you; B5
   stops the toast you want from fleeing.

Then: **Ash + Vaal presets + the Appearance panel** — the visible payoff, cheap once (2) is done; Sekhemas next; Divinity last (light-mode overrides).
Then B6–B8 and C1–C5 as a "feel" pass; C6–C9 fold
into whatever pass touches those files.

**Verification for every step** (per CLAUDE.md): `ops/run-tests.sh` green (the linter is in it),
then drive the packaged app over CDP — Board tiles on a theme switch, the Ash accent-vs-loss pair,
the route table while streaming — before commit, and give the owner the packaged build for the user
check.

---

## 4. Rejected alternatives (the record)

- **A `theme.js`-owned palette (JS objects, CSS generated from them)** — moves the source of truth
  out of `:root`, which the linter parses; adds a runtime for something CSS does natively.
- **A runtime resolver / getters over `getComputedStyle` for Recharts** — silently leaves
  `InflationView`/`MarketView` axes and tooltips on Vault (module-level constants). `var()` strings
  are proven and need no subscription.
- **`color-mix()` for the alpha uses** — works, but the channel triplets are a 1:1 mechanical rewrite
  and make the linter check exact; a percentage form is a second thing to review per preset.
- **Presets in a separate `themes.css`** — puts them outside every existing linter check and makes
  the new theme pass load-bearing on its own. One file, one diff.
- **Renderer reports its resolved `--bg` to Electron** instead of a table — clever, but an arbitrary
  colour string over IPC is less reviewable than an id; the table is four lines.
- **Renaming `--gold` → `--accent`** — 60+ call sites, no behaviour change; presets override the
  value, the name is fine.
- **Keeping all five tabs mounted behind `display:none`** — five poll loops and stream lifecycles
  running unseen; `BoardView` is `key={league}` for a reason. Real felt speed-up, riskiest item in
  the arena, not a UI change. Reconsider for Board alone, later.
- **`AnimatedNumber` on every big figure** (capital pill, stat values) — additive motion where a
  number is read, not watched. Fix the mount bug only.
- **A light theme** — the arena rejected it ("a second design system, not a preset"); overturned by
  the owner for Divinity alone on 2026-09-18, with the dark-only assumptions listed in §1.3 #3 as the
  price. Still no second light theme.
- **Theming `series`, `--rarity-*`, or gain/loss hue** — validated palettes and game semantics.
- **A blood-*accent* Vaal preset** — blood as the accent collides with `--loss`/`--offline`/the corrupted orb. The shipped Vaal (§1.3 #5) puts blood on `--loss` and the wash and uses corruption magenta as the accent.
- **Per-token user customisation** — makes the contrast gate meaningless; UI nobody trades with. (Revisited 2026-09-18: if anyone asks, the version that fits is a sixth "Custom" preset with a few pickers and everything else derived with contrast auto-corrected. **BUILT 2026-09-18** as *custom themes* — Settings → Appearance → "Custom themes": eight primaries (background, panel, text, accent, gain, loss, live, digest), every other token derived in OKLCH from the relationships the presets already follow (`frontend/src/lib/themeDerive.js`; `test/theme-derive.test.mjs` prints the per-preset error), the linter's contrast rules shown inline with an auto-fix, and an Advanced disclosure that pins any derived token. Themes stay colour-only and live in the settings blob (`custom_themes`). **Codify workflow** for tweaking a shipped preset: "New from <preset>" → edit the copy while the app previews it → Export (copies a `:root[data-theme="<slug>"] { … }` block in the presets' own line order + JSON) → paste the block over the preset's block in `styles.css` (rename the selector), keep `BACKDROPS` in `desktop/src/main.js` equal to its `--backdrop`, run `npm run lint:style`. Presets are never edited in place from the UI.)
- **A topbar theme switcher; a preview gallery; a View-Transitions cross-fade** — pressed four times
  ever / a page nobody returns to / a 300 ms novelty with a reduced-motion branch to maintain.
- **Per-theme fonts, textures, boss art, sound packs; UI click sounds** — a costume, not joy.
- **Deleting the σ separator rows entirely** — the gap is information the user acts on; only the
  label is our reasoning.
- **Deleting the 11 retired `.m4a` files now** — cheap to do later; keep until the curated list has
  lived through a beta.

---

## Palette research record (2026-09-18)

Four researchers pulled official art, wiki and screenshot references per theme and ran a k-means
extractor; the owner then supplied the four defining images the final palettes are built from (the
Pinnacle of Flame arena screenshot, the Arbiter of Divinity 0.5.0 key art, a Zarokh arena
screenshot, the Vaal temple key art). Findings that changed the plan:

- **The Arbiter of Divinity is real** — added in 0.5.0 "Return of the Ancients" (May 2026), fought
  on the Origin Tower roof, lightning aspect, gilded bronze with white-gold wing fire; the arena is
  daylight (poe2db `The_Arbiter_of_Divinity`; official 0.5.0 patch notes, forum thread 3932540).
  The arena's "cold indigo radiance" reading was invented; the palette is warm, and it is now the
  light theme.
- **Ash** — the arena floor is baked rust-ochre with real chroma (h14–22, s30–57); environment fire
  is 25–33°, the boss's flesh glow 11–18°; no blue, violet or green anywhere but the ice mechanic
  (poe2db `The_Arbiter_of_Ash`; poe-vault and Screen Rant boss guides).
- **Sekhemas** — the trial is Maraketh (not Faridun); the halls are crimson-sand under brazier light
  and Zarokh's arena is the one cool room (violet-grey, indigo lightning). The owner chose Zarokh's
  arena as the reference, so the preset is the cool one; "lapis" appears nowhere in the trial
  (poe-vault trial guide; mobalytics Zarokh).
- **Vaal** — corruption light is red (h350–358) with a rose bloom at 330°; Vaal stone is cool
  blue-grey basalt in interiors and olive sandstone in Utzaal, never green; the Vaal Orb is
  red-orange; Doryani's machinery is indigo, not copper (pathofexile wiki `Vaal_side_area`,
  `Corrupted`; poe2db `Vaal_Orb`; maxroll Act 3). The owner's temple key art is oxblood + brass +
  blood-red, which is what the preset uses.
- **Method caveat:** every ratio in §1.3 was recomputed by script from the listed hexes, not taken
  from the researchers. The palette canvas holds the reference images and their clusters.

## Arena record

Four candidates (two Fable, two Opus), one Opus cross-judge, 2026-09-18. **Base: candidate 4**
(judge 29/30, parent agreed): most factually accurate (every spot-check landed; it alone found the
flash bug B2, the `.streaming::after` gap, the `unlockSound` gap and the "Changes save
automatically." line), the linter prescription that matches the actual parser, the smallest new
surface. **Grafts:** from candidate 1 — `theme.js` as `var()` aliases (the only Recharts mechanism
that survives the module-level constants), dropping `layout` from `Tile`, stop toasting saves, the
finite update-chip pulse, emoji → glyphs, the `Cur` placeholder disc, Divinity's lower glow alphas;
from candidate 2 — freeze the route sort while streaming, `useReducedMotion()` on the `motion`
springs, the focus trap's return-focus, the `small` CurrencyPicker variant; from candidate 3 — the
WCAG contrast assertion in the linter, `⌘1–5` / `?`, the tone curation with the `merge()` safety
check, the original Vaal rejection (since overturned by the owner's stone/blood/corruption reframe — see §1.3 #5). **Rejected from candidates** as listed in §4. **Dropouts:** none.
**Factual corrections made during synthesis:** gold literal count is 26 lines (candidates said
26/32/28/28); gain 7 / loss 3 (not 10/4); candidate 2's `ws-chip.ee2` does not exist; candidate 3's
"charts read `color.x` at render" is false; candidate 1's presets would have failed linter check 2
as written. **Convergence** (settled, not re-litigated): the literal sweep before any preset;
`:root[data-theme]` blocks; three-tier storage; never theme series/rarity/alert-red/non-colour; no
light theme; no UI sounds; the same nine §0 cuts; the `AnimatedNumber` mount bug; the
`<CurrencyPicker>` swap.
