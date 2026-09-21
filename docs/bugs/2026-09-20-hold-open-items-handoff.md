# HANDOFF — Hold's remaining open items after 0.3.2

Companion to [`2026-09-20-hold-ranks-against-its-own-forecast.md`](2026-09-20-hold-ranks-against-its-own-forecast.md),
which is the diagnosis and the shipped fix. **This doc is the durable state of what is still open.** An agent
picking this up after a context compaction should be able to continue from here without re-deriving anything.

**Shipped in `0.3.2` (2026-09-20):** sign-safe score `log(1+ret) + CAUTION_K·log(1+mdd)`, a relative
traded-value floor (top 50% of the day + n≥4), a −40% drawdown cap, and the Caution slider. Owner-validated on
beta; telemetry clean on win32 + darwin. Four items below were deliberately left out of that change.

**Second measurement pass, 2026-09-20 (later the same day):** item 1's decisive experiment has now been RUN.
Findings are in item 1. Item 3 lost its most promising fix. Item 2 became entangled with item 1 and must now
ship in the same change. Nothing has been altered in production code since `0.3.2`.

---

## ⚠️ Read this before re-running any measurement

**The measurement trap.** Any "return up to day t" and any "return from day t" share the price at day t, so its
measurement noise manufactures a fake reversal. Measured naively, trailing return looks strongly *anti*-predictive
(IC −0.21, t = −42) and you will conclude the board is sorted backwards. It is not.

| gap between score date and forward window | 0 | 1 | **2** | 5 |
|---|---|---|---|---|
| IC (trailing return), 3d | −0.205 | −0.110 | **+0.009** | +0.026 |

`_smooth` spans ±1 day, so **gap ≥ 2 is the minimum clean decoupling**. This is the same reason Jegadeesh &
Titman skip a week. The gap is a *measurement* device only — it is not a product change and the board still
scores day 1 with day-1 data.

**The gap rule does NOT apply to the forecast.** `_predict` reads only *past* leagues' prices; the current
league's `p[N]` never enters it. There is no shared endpoint, so gap 0 is the forecast's unbiased native
setting. Confirmed empirically: the forecast's IC is gap-insensitive. Score numbers need gap ≥ 2; forecast
numbers do not. Do not "correct" forecast measurements with a gap — it only mismatches the windows.

**Settled, do not re-litigate:**
- `ret × depth` was *not* a bug — it is a posterior mean with a zero prior. Only `stab`/`liq` were sign-broken.
- The equity "short-horizon reversal" literature does **not** transfer here; on our data the signal is positive.
- `CAUTION_K` saturates at 3 (top-10 drawdown flat at −14.0% from k=3 up). Higher k costs return for nothing.
- −40% is the tightest drawdown cap that spares Mirror/Hinekora (−35% cuts them 25%/27% of early-league days).
- An **absolute** value floor cannot work: the scale shifts ~14× between leagues and 30M was unreachable
  (0% coverage in the first 30 days).
- **The forecast is not junk.** Measured IC is positive and outside the permutation null. See item 1.
- **Raising `MIN_PRED_LEAGUES` 2 → 3 is NOT justified by skill.** It looks justified (forecast IC +0.027 on
  n=2 items vs +0.320 on n≥3 items, 7d) until you notice the SCORE shows the same gap on the same items
  (+0.091 vs +0.311). Those are simply more predictable items. Confounded; do not use this argument.
- **No signal of any kind survives league-day 30.** Score, `_predict`, and a day-blind cross-league average all
  go to zero together. Stop looking for one that doesn't.

**The harness.** Rebuilt 2026-09-20 and living in the session scratchpad as `ic_harness.py`, `adversarial.py`,
`decisive.py`, `window.py`, `lagcurve.py`, `band.py`, `bench.py`. **These are session-scoped and will be lost
again unless committed.** They import production `_metrics` / `_predict` / `hold_score` / `eligible` unchanged
and read a read-only copy of `market.sqlite`; they write nothing. To rebuild from scratch: read `league_daily`
per league via `_build_league`, walk each target league day by day computing `_metrics` over `ages <= t` only,
measure realized return, and take the daily cross-sectional Spearman between signal and forward return,
averaged over days.

**Harness sample size is smaller than the score-only backtest.** The forecast needs ≥2 prior leagues, so only
**Fate of the Vaal, Runes of Aldur and Forbidden Rites** can be target leagues. Three league-openings, 12–33
daily cross-sections per phase bucket. Daily ICs overlap, so printed t-stats read better than the independence
warrants. Treat directions as well-supported and magnitudes as soft.

**Harness validation.** Independent code reproduces the score curve's headline shape and hits **+0.285 at
league-days 4–7 (7d)** against the original backtest's published **+0.281**. The middle buckets differ (8–14,
15–30) because of the smaller league set and the eligibility filter. It is not a bit-for-bit reproduction.

**Backtested score ≠ shipped score.** Production overrides `ret` with hourly exchange cards
(`movers.exchange_cards`) when the card is in the right numeraire. Past leagues exist only as daily closes, so
every score number in this doc and its companion — original backtest and second pass alike — is the
daily-close variant. This gap is not closeable with the data we have.

---

## 1. The board can recommend what it predicts will fall

**State: MEASURED 2026-09-20, decision pending.** The ranking score and the `pred_pct` column are still computed
by unrelated methods and never meet. What changed is that we now know what the forecast is worth.

Live-board correlation between the two, unchanged from the first pass (n = 374 assets with a prediction):

| horizon | corr(score, predicted return) | p |
|---|---|---|
| 1d | −0.030 | 0.56 |
| 3d | −0.000 | 0.99 |
| 7d | +0.126 | **0.014** |

### 1a. The forecast has real skill

Walk-forward, gap 0, eligible board, three target leagues:

| horizon | forecast IC | t (non-overlapping) | coverage of the ranked board |
|---|---|---|---|
| 1d | +0.065 | +2.7 | 58% mean / 64% median |
| 3d | +0.082 | +2.0 | " |
| 7d | +0.054 | +1.4 | " |

**Permutation null** (shuffle the forecast across items within each day, 660–2940 draws): mean **+0.001 to
−0.015**, sd 0.144–0.255. The plumbing is clean and the real ICs sit well outside it.

Skill is concentrated in the opening fortnight and gone afterwards:

| 7d, IC by league phase | 4–7 | 8–14 | 15–30 | 31–60 | 61+ |
|---|---|---|---|---|---|
| forecast | **+0.533** | **+0.283** | −0.070 | −0.019 | −0.017 |

**Leave-one-league-out, opening fortnight, 7d** — the forecast beats the score in every league:

| | Fate of the Vaal | Runes of Aldur | Forbidden Rites |
|---|---|---|---|
| score | +0.147 | +0.167 | +0.267 |
| forecast | **+0.294** | **+0.358** | **+0.328** |

At 3d it wins in two of three (Vaal +0.228 vs +0.198, Aldur +0.297 vs +0.230, Forbidden +0.062 vs +0.109).

Cross-sectional `corr(score, forecast)` is +0.03 (3d) / +0.09 (7d) — close to orthogonal, so the information is
additive rather than a restatement of the score.

**So the doc's earlier "lean rename" prior was wrong.** Renaming the board and dropping the forecast would
discard the better of the two early-league signals.

### 1b. But the day-alignment is not what's producing the skill

The module docstring calls the forecast "the league-phase analog": at day N, read each past league's return from
day N to N+Δ. That specific claim does not survive testing.

**Day-shift placebo.** Reading the forecast from a wrong league-day (N+40) collapses it to ~0 everywhere, but
reading it from N−30 keeps most of the skill. Shifts of +3/+7/+14 barely move it. What matters is being in the
early-league *regime*, not hitting day N.

**Day-blind baseline.** Same code shape, same `_smooth`, same recency weights, but averaging over *every* start
day in each past league instead of the matching one. It beats `_predict`, head-to-head on identical rows:

| | days ≤14 | all days |
|---|---|---|
| `_predict` (day-aligned) | +0.383 | +0.054 |
| day-blind average | **+0.406** | **+0.200** |
| difference | −0.047 (t −2.0) | −0.152 (t −5.7) |

The mechanism is variance, not seasonality: `_predict` rests the whole estimate on **one day-pair per past
league**, i.e. 2–4 noisy numbers.

### 1c. The fix is to widen the start day, not to abandon alignment

Do **not** conclude from 1b that alignment should be dropped. A window ladder — phase alignment and recency
weights intact, averaging start days over `N±w` — shows the optimum is at a **finite** width, with identical
rows compared at every width:

| window | 3d, days ≤14 | 3d, days >14 | 7d, days ≤14 | 7d, days >14 |
|---|---|---|---|---|
| ±0 (production) | +0.263 | +0.029 | +0.383 | −0.033 |
| ±2 | +0.305 | +0.010 | +0.388 | −0.042 |
| ±3 | +0.303 | −0.011 | +0.391 | −0.041 |
| **±5** | **+0.317** | −0.021 | **+0.394** | −0.030 |
| ±7 | +0.320 | −0.017 | +0.392 | −0.025 |
| day-blind | +0.301 | +0.043 | +0.429 | +0.130 |

At 3d the curve peaks around ±5–7 and falls off toward day-blind. That peak is the evidence that phase alignment
carries information. The day-blind advantage seen in 1b lives almost entirely in the **late** league, which is
the dead zone anyway.

Cost is negligible. Whole live board, 108 ranked assets, 4 past leagues: **0.51 ms at ±0 → 2.35 ms at ±3 →
3.57 ms at ±5.** No extra DB reads (the series are already in `build_context`), and it sits behind the existing
600 s leaderboard cache. Nothing to compensate for.

### 1d. What the source literature says, and why we are departing from it

Hold's prediction is return seasonality, and both founding papers deliberately use **one matching period per
prior cycle**. Verified verbatim from primary PDFs:

- **Heston & Sadka**, "Seasonality in the Cross-Section of Stock Returns" (Oct 2006 manuscript,
  https://w4.stern.nyu.edu/finance/docs/pdfs/Seminars/063f-sadka.pdf): *"Therefore we choose a methodology
  based on returns over a single month."* Their reason is empirical — sorting on the 12-month lag pays
  **+115 bp/month, the 13-month lag < −30 bp, the 14-month lag −50 bp** — *"the sharp difference between
  returns in one month and returns in adjacent months."* In equities, adjacent periods carry opposite-signed
  information, so widening cancels signal.
- **Keloharju, Linnainmaa & Nyberg**, NBER WP 20815 (https://www.nber.org/system/files/working_papers/w20815/w20815.pdf):
  µ̂ is *"each stock's average same-calendar-month return from the prior 20-year period"*, cross-sectionally
  demeaned, including *"stocks that have at least five years of historical data at time t."* One observation
  per year, 5–20 of them, never a neighbourhood.
- **The same authors' "Seasonal Reversals"** manuscript proves the general case: *"averaging leaves the
  signal-to-noise ratio unchanged"* when adjacent periods are independent, and when seasonality reverses,
  *"the average return over a year does not contain any information about expected returns."*

That is a **conditional** result: widening is neutral when adjacent periods are independent, harmful when they
reverse, and helpful only when they share the same expected return. The condition is testable, so we ran
Heston & Sadka's own test on our data — one offset at a time, no averaging:

| offset from aligned day | −7 | −3 | −1 | **0** | +1 | +3 | +7 |
|---|---|---|---|---|---|---|---|
| 7d, league days ≤14 | +0.137 | +0.302 | +0.355 | **+0.389** | +0.390 | +0.358 | +0.264 |
| 7d, league days >14 | −0.032 | −0.058 | −0.054 | **−0.035** | −0.016 | −0.015 | +0.059 |

**Early league: a broad, smooth, entirely positive hump.** Neighbouring days carry the same signal, so averaging
them cancels noise rather than signal — the one regime where widening helps. **Late league: near zero and
sign-flipping**, the equity-like regime where widening hurts, and it does.

A league economy has a smooth early arc; equity calendar months have a sharp pulse. Different objects. **The
justification for widening is our measurement, not the papers** — the papers told us exactly what could go
wrong and how to check it.

### 1e. The change, and the trap inside it

The proposal is a recognised estimator: averaging same-length returns over shifted start days is **overlapping
data inference**, Hansen & Hodrick (1980), formalised by Hedegaard & Hodrick, NBER WP 19969
(https://www.nber.org/system/files/working_papers/w19969/w19969.pdf). They confirm the simple average is
asymptotically as good as the constrained GMM version.

**But the band must go UP, not down.** Verbatim: *"While the basic monthly model does not 'see' this variation,
the ODIN model recognizes the variation that comes from changing the starting date resulting in a larger
standard error."*

Ours currently goes the wrong way. Measured on the live board (Forbidden Rites, league-day 16, 108 ranked
assets, 70 with a forecast at every width):

| window | 3d median \|pred\| | 3d median band | 7d median \|pred\| | 7d median band |
|---|---|---|---|---|
| ±0 (production) | 31.1% | 36.4% | 52.8% | 43.9% |
| ±3 | 19.5% | 21.7% | 45.7% | 41.0% |
| ±5 | 13.7% | 15.4% | 40.8% | 34.0% |

`band` is `pstdev` *across leagues*. Averaging within each league launders the start-day noise out before the
spread is taken, so the band shrinks. Shipping that alone would print a tighter ± on top of a ± that item 2
already measures as 4–22× too small.

**Therefore the window change and the band fix are ONE change.** Compute the band from the start-day spread as
well as the cross-league spread — Hedegaard & Hodrick hand us that diagnostic for free, it falls out of the same
loop: *"the estimate moves slowly with the sampling start date"* is the stable case; a swing means the
single-day estimate was never trustworthy.

Two cautions recorded but not acted on:
- The gain is smaller than the observation count suggests — 22 start days bought them a 15% SE reduction, not √22.
- Their validated regime is not ours: *"we use only relatively long samples in which the overlap remains a small
  fraction of the sample size."* Ours would be a large fraction of a 3–4 month cycle seen 2–4 times.

### 1f. Still undecided

Widening makes the post-day-30 board slightly *worse* (3d: +0.029 → −0.011 at ±3). It is already noise there, so
the options are to accept it or to gate the width on league phase. Gating adds a branch for no user-visible
benefit while item 3 is unresolved. **Recommendation: accept it, and revisit if item 3 ships a phase gate anyway.**

The change also alters what `pred_pct` *means* — from "forward return from day N" to "typical forward return
around this point in past leagues". That is a product/naming decision, not a code one.

**Not doing yet: blending the forecast into the ranking.** A 50/50 rank blend measures well early (7d, days 4–7:
**+0.525** vs the score's +0.322; days 15–30: +0.400 vs +0.359), but tuning a blend weight on three leagues is
how you overfit. Gelman (2006), verified verbatim, on estimating a shrinkage/pooling parameter from few groups:
it works *"unless the number of groups J is low (below 5, say)"*. We have 4. Fix the estimator first; revisit
blending as a separate change with a fixed, un-tuned weight.

## 2. The ± band understates uncertainty by 4–22×

**State: open, and now entangled with item 1 — they must ship together.** See 1e.

`_predict` returns `statistics.pstdev(vals)` over 2–4 past leagues. Two compounding faults:

1. `pstdev` (÷n) rather than sample SD (÷n−1), with no `c₄` correction → at n=2 the printed band is **56.4%** of
   an unbiased estimate of the spread.
2. It is the wrong object. For "how wrong might this be for *this* league" the right interval is a prediction
   interval. Verified arithmetic — the honest 95% half-width as a multiple of the printed `pstdev`:

| n past leagues | 2 | 3 | 4 |
|---|---|---|---|
| × printed band | **22.0** | 6.1 | 4.1 |

So a displayed "−5.9% ±151" should be roughly **±3300**. This is not merely imprecise — it is **miscalibrated in
the confident direction**, which closes the one defence the forecasting literature offers (Gneiting's
"unsharp but calibrated is fine" explicitly requires calibration).

On the live board today the n-league mix is `{none: 38, n=2: 11, n=3: 38, n=4: 21}` out of 108 ranked assets, so
the 22× worst case applies to 11 rows.

**Decision needed, and the literature is genuinely split:**
- **Show it honestly** (Gneiting): a wide band is a fact about the market, not a display defect.
- **Suppress it** (NCHS/MCHB presentation standards): relative CI width > 1.2× the estimate is flagged
  unreliable. **58–64% of our column** would be flagged or suppressed under that standard. Note that widening
  does *not* rescue this: band/|pred| stays ≈1.0–1.2× at every width tested.

**Do not "fix" this with a tooltip.** Padilla/Kay/Hullman: uncertainty "is commonly ignored or mentally
substituted for simpler information", and the misreading **survives explicit instruction**. Readers anchor on
the point estimate regardless of what the caption says.

**Minimum viable fix:** use sample SD. **Correct fix:** print a prediction interval, with the start-day spread
folded in per 1e. **Honest fix:** if the interval is ±3300, don't print a confident-looking number at all.

## 3. Hold's signal is gone by league-day 30 and the board doesn't say so

**State:** open, **time-sensitive**, and its most attractive fix is now ruled out.

IC by league phase (7d horizon, gap=2):

| league day | 1–3 | 4–7 | 8–14 | 15–30 | 31–60 | 61+ |
|---|---|---|---|---|---|---|
| IC | +0.208 | **+0.281** | +0.241 | +0.177 | +0.006 | −0.012 |

For scale, an equity signal with IC 0.03–0.05 is usable. The opening fortnight is genuinely strong; after day 30
the board is noise, and it presents that noise with exactly the same confidence.

**Ruled out 2026-09-20: the forecast cannot rescue the late league.** It dies in the same place — 7d IC −0.070
(days 15–30), −0.019 (31–60), −0.017 (61+). Nor can the day-blind variant: 31–60 is **+0.003** (7d) / **−0.029**
(3d). The 61+ bucket reads positive (+0.215 at 7d) but that is 30 days from one league and should not be
trusted. Score, forecast and day-blind average all fail together.

**Timing:** Forbidden Rites was at league-day 16 on **2026-09-20**, so it crosses day 30 around **2026-10-04**.
After that date the shipped board is ranking on a signal that no longer predicts anything.

**Options, cheapest first:**
- Surface league phase as context (the `arc-chip` already computes day + phase — reuse it, don't build a page).
- Degrade gracefully: past day ~30, fall back to ranking on drawdown/steadiness alone, which is at least an
  honest "what has held value" rather than a forecast-shaped nothing.
- Say nothing and accept it. Defensible only if Hold is understood as an early-league tool.

**Do not** solve this by narrating the reasoning on the card — `CLAUDE.md` §0 restraint. A setting with a sane
default, or a phase chip, not an explanation.

## 4. (Adjacent) Inflation's headline disagrees with the Board

**State:** open, shipped knowingly in `0.3.2` and recorded in that release commit.

`backend/app/inflation.py` still reads the newest single hour (raw `vol_a`/`vol_b`, and `change_24h` from
`basket[-1] / prev`), while the Board has priced off the 48-hour window since `0.3.2-beta.1`. Before 0.3.2 both
used the single hour, so they agreed; this release introduced the disagreement.

Its four headline numbers are affected: `current`, `since_base_pct`, `change_24h_pct`, `velocity`. The
**series** is internally consistent — only the headlines are off. `velocity` is the shakiest: it is a mean of
hour-to-hour log returns, precisely the noise `window_rates` was built to remove.

**Fix shape:** route the headline through `digest.window_rates`, or fold the series the way
`arbitrage/board.py::_fold_series` already does. That helper is the existing, tested precedent — reuse it rather
than writing a second fold.

---

## Sources: verified vs not

**Verified verbatim from primary PDFs** (local copies were in the session scratchpad and are not durable):
Heston & Sadka Oct-2006 manuscript (single-month rationale; 12/13/14-month spreads; "adjacent months"); KLN
NBER WP 20815 (eq. 9, 20-year same-calendar-month average, demeaning, ≥5 years); "Seasonal Reversals"
manuscript (signal-to-noise algebra); Hedegaard & Hodrick NBER WP 19969 (larger standard error, moves slowly
with start date, small-fraction-of-sample caveat); Gelman (2006) *Bayesian Analysis* §7.1 (J below 5).

**NOT verified — do not cite as sourced:** the published *Journal of Finance* 2016 KLN text (closed access; no
repository copy; the estimator above comes from the same authors' companion working papers); the published
*JFE* 2008 Heston & Sadka text; Brown & Warner (1985)'s 79.6% → 13.2% power figure (reported by a research
agent, not located in our own extraction); Miller & Williams on shrunk seasonal factors (paywalled). No primary
source was found that quantifies "bias from including a different regime" for a shifted-start-day average —
that gap is real, and our own lag curve is what stands in for it.

---

## Suggested order

1. **The window + the band, as one change** (items 1 and 2). Widen `_predict`'s start day to a phase window,
   and take the band from the start-day spread as well as the cross-league spread. Measured, cheap (≈2 ms),
   and the band half is what stops it being a regression in disguise. Decide the `pred_pct` label at the same
   time.
2. **Item 4** — smallest, self-contained, an existing helper to reuse, and it removes a user-visible
   contradiction that this release introduced.
3. **Item 3** — before 2026-10-04, or it becomes a live problem rather than a theoretical one.
4. **Blending the forecast into the ranking** — only after 1, with a fixed weight, and only if someone accepts
   that three leagues cannot tune it.

Any change here goes through `/tdd`, and the board-level wiring must have a failing test *before* the fix —
the existing suite was teeth-checked by restoring the old formula and confirming 5 tests go red. Keep that
property: a test that cannot fail is not protecting anything.
