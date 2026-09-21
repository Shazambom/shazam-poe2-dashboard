# HANDOFF — Hold's remaining open items after 0.3.2

Companion to [`2026-09-20-hold-ranks-against-its-own-forecast.md`](2026-09-20-hold-ranks-against-its-own-forecast.md),
which is the diagnosis and the shipped fix. **This doc is the durable state of what is still open.** An agent
picking this up after a context compaction should be able to continue from here without re-deriving anything.

**Shipped in `0.3.2` (2026-09-20):** sign-safe score `log(1+ret) + CAUTION_K·log(1+mdd)`, a relative
traded-value floor (top 50% of the day + n≥4), a −40% drawdown cap, and the Caution slider. Owner-validated on
beta; telemetry clean on win32 + darwin. Four items below were deliberately left out of that change.

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

**Settled, do not re-litigate:**
- `ret × depth` was *not* a bug — it is a posterior mean with a zero prior. Only `stab`/`liq` were sign-broken.
- The equity "short-horizon reversal" literature does **not** transfer here; on our data the signal is positive.
- `CAUTION_K` saturates at 3 (top-10 drawdown flat at −14.0% from k=3 up). Higher k costs return for nothing.
- −40% is the tightest drawdown cap that spares Mirror/Hinekora (−35% cuts them 25%/27% of early-league days).
- An **absolute** value floor cannot work: the scale shifts ~14× between leagues and 30M was unreachable
  (0% coverage in the first 30 days).

**The scratchpad harness is gone** (session-scoped). To rebuild it: read `league_daily` per league via
`holdscore.build_context`, walk each past league day by day computing `_metrics` over `ages <= t` only, measure
the realized return from `t+2` to `t+2+h`, and take the daily cross-sectional Spearman between score and forward
return, averaged over days. Four past leagues give ~166k observations. Everything below was measured that way.

---

## 1. The board can recommend what it predicts will fall

**State:** open. The ranking score and the `pred_pct` column are computed by unrelated methods and never meet.

Measured (n = 374 assets with a prediction):

| horizon | corr(score, predicted return) | p |
|---|---|---|
| 1d | −0.030 | 0.56 |
| 3d | −0.000 | 0.99 |
| 7d | +0.126 | **0.014** |

Live examples at the time of writing: 3d `#2 Perfect Orb of Augmentation` (pred −11.1%), `#10 Perfect Exalted
Orb` (−31.5%). At 1d, assets predicted to *fall* had a higher mean score than those predicted to rise.

**The decisive experiment has NOT been run.** We measured the IC of the *score*. Nobody has measured the IC of
the *forecast itself* — the cross-sectional correlation between `pred_pct` and realized forward return, using
the same walk-forward harness. That one number decides the whole item:

- **IC materially > 0** → integrate it into the score *before* ranking. AQR's finding is that integrating
  "avoid[s] stocks with offsetting style exposures", which is literally this bug. Weight it by its measured IC
  (Grinold: `alpha = volatility × IC × score`) or as a Black-Litterman view whose confidence is that IC. Keep the
  blend simple — estimated optimal weights routinely lose to fixed ones (the forecast-combination puzzle).
- **IC ≈ 0** → do not integrate. Rename the board to describe what it measures and stop implying a forecast.
  FINRA 2210(d)(1)(F) forbids implying "past performance will recur"; FCA COBS 4.6.2 R forbids past performance
  being "the most prominent feature" — and a sort order is the most prominent position there is. Morningstar's
  convention is two separately-named ratings, one "Backward-looking", one "Forward-looking", allowed to disagree.

**Prior:** lean rename. The forecast rests on 2–4 past leagues and 39% of assets have none. But measure first.

**Note in its favour:** the method *is* return seasonality, which is JF-published (Keloharju/Linnainmaa/Nyberg
2016) and documented to work "at the daily frequency". It is not obviously junk — it is unmeasured.

## 2. The ± band understates uncertainty by 4–22×

**State:** open. `_predict` returns `statistics.pstdev(vals)` over 2–4 past leagues. Two compounding faults:

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

**Decision needed, and the literature is genuinely split:**
- **Show it honestly** (Gneiting): a wide band is a fact about the market, not a display defect.
- **Suppress it** (NCHS/MCHB presentation standards): relative CI width > 1.2× the estimate is flagged
  unreliable. **58–64% of our column** would be flagged or suppressed under that standard.

**Do not "fix" this with a tooltip.** Padilla/Kay/Hullman: uncertainty "is commonly ignored or mentally
substituted for simpler information", and the misreading **survives explicit instruction**. Readers anchor on
the point estimate regardless of what the caption says.

**Minimum viable fix:** use sample SD. **Correct fix:** print a prediction interval. **Honest fix:** if the
interval is ±3300, don't print a confident-looking number at all.

Note this item is entangled with #1: if the forecast is removed or renamed, the band question dissolves.

## 3. Hold's signal is gone by league-day 30 and the board doesn't say so

**State:** open, and **time-sensitive**.

IC by league phase (7d horizon, gap=2):

| league day | 1–3 | 4–7 | 8–14 | 15–30 | 31–60 | 61+ |
|---|---|---|---|---|---|---|
| IC | +0.208 | **+0.281** | +0.241 | +0.177 | +0.006 | −0.012 |

For scale, an equity signal with IC 0.03–0.05 is usable. The opening fortnight is genuinely strong; after day 30
the board is noise, and it presents that noise with exactly the same confidence.

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

## Suggested order

1. **Measure the forecast's IC** (item 1). One number, reuses the harness above, and it also decides item 2.
2. **Item 4** — smallest, self-contained, an existing helper to reuse, and it removes a user-visible
   contradiction that this release introduced.
3. **Item 3** — before 2026-10-04, or it becomes a live problem rather than a theoretical one.
4. **Item 2** — follows whatever item 1 decides.

Any change here goes through `/tdd`, and the board-level wiring must have a failing test *before* the fix —
the existing suite was teeth-checked by restoring the old formula and confirming 5 tests go red. Keep that
property: a test that cannot fail is not protecting anything.
