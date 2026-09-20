# BUG — the Hold board ranks assets against its own forecast, and rewards the worst losers

**Status:** FIXED (uncommitted, 2026-09-20) — the score, floor and cap below are implemented in
`backend/app/holdscore.py` behind `backend/tests/test_hold_score.py` and driven in the packaged app. The three
items under "Still open" are deliberately NOT part of it. · **Severity:** medium-high — the board's title is an instruction ("What to hold") and
its sort order is a signal the literature says has the *opposite* sign at this horizon; separately, the bottom
half of the board is ordered close to backwards · **Found:** 2026-09-20, owner reported "it's displaying some
currencies we're actually predicting will go down" · **Affects:** every build since `b11d32b` (Hold shipped);
the `× stab` half since `4d7b145`. Backend-only (`backend/app/holdscore.py`), all platforms.

## What was seen

Reproduced against a read-only copy of the owner's real `market.sqlite` (986k digest rows, league *Forbidden
Rites*, 609 scored assets). Probe scripts in the session scratchpad; nothing written to the live data dir.

The owner's report, confirmed. Top-25 rows that the board ranks highly while predicting a fall:

```
3d board:  #2  Perfect Orb of Augmentation   ret +51.4%   hold 0.2656   pred -11.1%
           #10 Perfect Exalted Orb           ret +18.0%   hold 0.1120   pred -31.5%
           #14 Perfect Jeweller's Orb        ret +49.4%   hold 0.0792   pred -30.5%
7d board:  #4  Perfect Chaos Orb             ret +94.0%   hold 0.5776   pred -14.1%
           #21 Perfect Orb of Augmentation   ret +47.9%   hold 0.2478   pred -26.5%
```

The ranking score and the forecast are essentially unrelated across the whole board (n=374 with a prediction):

| horizon | corr(hold score, predicted return) | p | mean hold, pred-UP | mean hold, pred-DOWN |
|---|---|---|---|---|
| 1d | −0.030 | 0.56 | −0.0010 | **+0.0021** |
| 3d | −0.000 | 0.99 | +0.0051 | +0.0050 |
| 7d | +0.126 | **0.014** | +0.0325 | +0.0115 |

At 1d, assets predicted to **fall** score *better* on average than those predicted to rise. (Note: only 1d and
3d are statistically independent. At 7d there is a weak but significant positive relationship — an earlier
draft of this analysis overstated the independence claim.)

Separately, among the 239 assets with a **negative** return, ordering is close to arbitrary — **61% of pairs
(17,261 / 28,441) are inverted**, i.e. the worse loss ranks higher:

```
board#  asset                      ret%   conf   hold
   222  Lesser Glacial Rune       -75.1   0.00  -0.0000
   605  Mirror of Kalandra         -9.4   0.65  -0.0500
   609  Potent Liquid Ferocity    -26.2   0.67  -0.1211
```

## Cause (confirmed in code)

`backend/app/holdscore.py:250-252`, the sort key:

```python
# hold = appreciation × (how confident/liquid) × (how stable) — a store-of-value
# score, not a chase-the-biggest-mover score.
"hold": round(m["ret"] * m["conf"] * m["stab"], 4),
...
assets.sort(key=lambda x: -x["hold"])        # :255
```

with, at `:118-121`:

```python
depth = len(ages) / (len(ages) + SHRINK_K)   # SHRINK_K = 8
liq   = min(1.0, valvol / VALUE_FLOOR)       # VALUE_FLOOR = 30M ex/day
stab  = max(0.15, 1 + mdd)                   # mdd is negative → stab ∈ [0.15, 1]
```

Three independent defects, plus one thing that is **not** a defect.

### Defect 1 — `× stab` inverts below zero (unambiguous)

`stab` was designed as a penalty. `4d7b145`'s own commit message: *"Stability factor **penalises** big drawdowns
— a good park doesn't crash."* But a penalty applied as a multiplier to a **signed** quantity reverses at the
sign boundary: for `ret < 0`, a smaller `stab` makes the score *less* negative, so it ranks *higher*.

Two assets, identical −10% return: one with a −5% drawdown scores −0.095; one that crashed 85% scores −0.015 and
ranks **six times better**. `ret × stab` is order-equivalent to `ret / (1/stab)`, so this is exactly the
documented negative-Sharpe pathology — CFA Institute, on Israelsen's *Refining the Sharpe Ratio* (verified
verbatim): *"When excess return is negative, the Sharpe ratio is also negative, which can be counterintuitive."*

`liq` has the same shape and the same bug: discounting an illiquid asset's **losses** toward zero reads as "you
can't lose money in things you can't trade," which is backwards. `liq` is a preference/constraint, not an
uncertainty weight — it does not make us less sure what the return *was*.

### Defect 2 — the ranking horizon is one where the published sign is negative

The board ranks on 1/3/7-day trailing return. Jegadeesh & Titman (1993) place momentum at **3–12 months** and
explicitly discard the most recent week (p.68): *"By skipping a week, we avoid some of the bid-ask spread, price
pressure, and lagged reaction effects…"* Asness/Moskowitz/Pedersen call skipping the recent month *"standard in
the momentum literature."* At weekly horizons the documented effect is **reversal**, strongest in exactly the
illiquid, high-turnover assets this board is full of (Avramov/Chordia/Goyal 2006). In crypto — 3,600 mostly-thin
coins, daily horizon — *"cryptocurrencies with low last day's return significantly outperform"* (Zaremba 2021).

Meanwhile `_predict` is a **return-seasonality** method, which is JF-published (Keloharju/Linnainmaa/Nyberg 2016)
and documented to work *"at the daily frequency."*

So the asymmetry is the reverse of what the UI implies: the *forecast* column rests on a documented effect at
this horizon; the *sort order* rests on a horizon where the published sign is the other way.

This is also a framing problem with a regulatory analogue. FINRA 2210(d)(1)(F) forbids communications that
*"imply that past performance will recur"*; FCA COBS 4.6.2 R requires past performance not be *"the most
prominent feature."* Sorting a board titled "What to hold" by trailing return is the most prominent position
available. Morningstar's answer is two separately-named ratings — *"Backward-looking, quantitative"* (stars) vs
*"Forward-looking"* (Medalist) — allowed to disagree because their labels say they answer different questions.

### Defect 3 — the prediction band understates uncertainty by 4–22×

`_predict` returns `statistics.pstdev(vals)` over 2–4 past leagues. Two compounding problems:

1. `pstdev` (÷n) rather than sample SD (÷n−1), then no `c₄` correction: at n=2 the printed band is **56.4%** of
   an unbiased estimate of the spread.
2. It's the wrong object entirely. For "how wrong might this be for *this* season" the right interval is a
   prediction interval. Verified arithmetic: the honest 95% half-width is **22.0× / 6.1× / 4.1×** the printed
   pstdev at n=2/3/4.

So "−5.9% ±151" should be roughly **±3300**. The display is not merely imprecise — it is *miscalibrated in the
confident direction*, which closes the one defence the forecasting literature offers (Gneiting's "unsharp but
calibrated is fine" explicitly requires calibration).

Supporting: 235/609 assets (39%) have no prediction at all; 58–64% have a band wider than |estimate|. Under
NCHS/MCHB presentation standards, relative CI width > 1.2× the estimate is flagged unreliable — the majority of
this column. And per Padilla/Kay/Hullman, *"uncertainty information is commonly ignored or mentally substituted
for simpler information"*, and the misreading **survives explicit instruction** — so a tooltip is a known non-fix.

### NOT a defect — `× conf` (specifically the `depth` half)

I initially called this a bug. It isn't. `ret × depth` = `(n/(n+8))·ret + (8/(n+8))·0` — a posterior mean under a
prior centred at zero. Under that reading, Lesser Glacial Rune at −75% / conf≈0 scoring ~0 is the estimator
working: *we don't believe that measurement*. The 61% inversion figure is the intended arithmetic of shrinkage,
not evidence of a defect, and whole-spectrum rank accuracy is arguably not this board's loss function anyway.

The real quarrels with `conf` are narrower:
- **The target should probably be the cross-sectional mean, not zero.** Every applied source shrinks toward a
  grand mean (IMDb's `C`, James–Stein's `ν`, Jewett's *"shrink observed health indices towards a regional mean"*).
  If the board's mean return is negative, zero is not neutral and unknown assets get pushed somewhere flattering.
- **Ranking by shrunken point estimates has no optimality guarantee here.** Lin/Louis (2006), verified verbatim:
  *"the optimal ranks are neither the ranks of the observed data nor the ranks of the posterior means"* — they
  coincide only *"when the posterior distributions are stochastically ordered"*, which this board maximally
  violates (Mirror's posterior is tight, a thin rune's is prior-wide).
- `depth` is an uncertainty weight and belongs in the estimate; `liq` is not and doesn't (Defect 1).

## Lineage — how this happened (the distinctive part)

Hold's design came from an arena pass over **open-source finance libraries**. That research is gone: the plan
that produced it points at `scratchpad/arena-strategy/SYNTHESIS.md` and `scratchpad/research-synthesis.md`,
neither tracked nor on disk. There is **no design doc for the Hold score** and never was — the only surviving
rationale is one sentence in `b11d32b`:

> Design from deep research (quant methodology + PoE2 asset classes) then a **/simplify pass that cut the
> multi-metric weighted-z score down to return×confidence** for v1.

**That sentence is the root cause.** A weighted-z composite is a *sum of standardised signed components* — each
keeps its sign, a penalty subtracts, and it is sign-safe by construction. `/simplify` replaced it with a
*product of a signed return and factors in [0,1]*, which cannot carry a penalty across zero. `4d7b145` then added
`× stab` onto the already-collapsed form and verified it *only on the winners*: *"Omens… now **top the board**;
noisy essences/catalysts fall away."* The negative half was never looked at. The reason for the collapse was
never recorded.

**The borrowed name proves the mechanism.** `stab` is almost certainly from empyrical's
`stability_of_timeseries` — a name that exists nowhere else in the ecosystem. But that function is (verified from
source at `40f61b4`) the **R² of an OLS fit to cumulative log returns**, a straightness-of-equity-curve
diagnostic. It has nothing to do with `1 + mdd`. In pyfolio it is a **row in a reporting table**, printed beside
Calmar/Sharpe/Sortino/Max-drawdown for a human to read. The perf-stats table was read as a scoring recipe: the
row list became a product.

**What the upstream libraries actually do** (all verified from pinned source):

| | form | negative return |
|---|---|---|
| empyrical `calmar_ratio` | `annual_return / abs(max_dd)` | penalty correctly worsens the score |
| empyrical `sharpe`/`sortino`/`omega` | ratios; signed numerator ÷ non-negative denominator | sign preserved |
| quantstats `serenity_index` | `(ret − rf) / (ulcer × pitfall)` | risk product in the **denominator** |
| quantstats `autocorr_penalty` | multiplies the **divisor**, and is **≥ 1** | deliberately sign-safe |
| quantstats `cpc_index`, `common_sense_ratio` | the only `A*B*C` products — every factor **non-negative** | no sign to destroy |

**Not one library multiplies a signed return by a [0,1] quality factor.** The invariant quantstats preserves and
we broke: *a multiplicative composite is only safe when every factor, including the performance term, is
non-negative.* The OECD/JRC *Handbook on Constructing Composite Indicators* says the same thing outright
(verified verbatim): non-comparable ratio-scale data *"can only be meaningfully aggregated by using geometric
functions, **provided that x is strictly positive**."*

**And on thin data, the ecosystem refuses rather than shrinks.** `if len(returns) < 2: return np.nan` appears 7×
in empyrical; ffn's deflated Sharpe uses `n < 3 → NaN`. Where confidence is modelled at all (quantstats
`probabilistic_ratio`, ffn `calc_deflated_sharpe_ratio`) it enters through the **standard error** and is reported
as a **separate probability** — never as a multiplier on the score. Our `n/(n+8)` is a real technique, but it is
from sports/marketing analytics, not from these libraries.

## Not the cause (ruled out)

- **Not the 0.3.2 window-rate change.** 350/609 assets take `ret` from the hourly exchange card via the new
  `window_rates` path, 259 from poe2scout dailies; spot-checked top rows are real market moves. Pre-existing,
  untouched by the beta.
- **Not bad data.** Returns reproduce from two independent sources and agree.
- **Not the DTW league-weighting.** It's a faithful port of `dtaidistance` with a 1:1 fuzz gate. It is, however,
  nearly inert: weights on the owner's data are `0.31 / 0.28 / 0.26 / 0.15` against a uniform 0.25, a Kish
  effective sample size of **3.76 of 4**. It retains 94% of a flat average.
- **Not the recency weighting.** `0.65^rank` costs ≤18% precision (ESS 1.91/2.68/3.29 at n=2/3/4, verified). A
  reviewer attacking it would be wrong; it is not where the problem lives.

## Experiments (2026-09-20) — what the data actually says

Backtested against four past leagues (166k–172k scored observations). At each league-day, score using only data
available *at that day*, then measure the realized forward return. Scripts in the session scratchpad
(`harness.py` + `exp1`–`exp13`); production code untouched.

**⚠️ Measurement trap, found and corrected.** A naive setup gave trailing return an IC of **−0.21** (t=−42),
which looks like the board is inverted. It is an artifact: any "return up to day t" and "return from day t" share
the price at day t, so its measurement noise manufactures reversal. Decoupling (gap ≥ 2 days, since `_smooth`
spans ±1) flips it:

| gap | 0 | 1 | **2** | 5 |
|---|---|---|---|---|
| IC (ret), 3d | −0.205 | −0.110 | **+0.009** | +0.026 |

This is why Jegadeesh & Titman skip a week. **The equity reversal finding does not transfer to this market** —
Defect 2's literature framing above is not confirmed on our own data. All numbers below use gap=2.

### The score works, and it works best in the opening fortnight

7-day horizon, scoring from league-day 1:

| league day | 1–3 | 4–7 | 8–14 | 15–30 | 31–60 | 61+ |
|---|---|---|---|---|---|---|
| IC (hold) | +0.208 | **+0.281** | +0.241 | +0.177 | +0.006 | −0.012 |

An equity signal with IC 0.03–0.05 is usable; 0.28 is very large. A fresh league is price discovery, not a
mean-reverting mature market. The signal **dies after ~day 30**. The top-10 basket beats the day's universe
median by **+24pp** over 7 days with a 6% crash rate. Hold is a real tool in the first month — the earlier
sections' pessimism about the ranking horizon is wrong, and the opening week must be kept.

### The "ridiculous suggestions" are thin assets, and `conf`/`stab` are a crude filter for them

Bottom liquidity decile: **63%** of assets move >50% in a week. Top decile: 10%. Stripping the multipliers
without a filter makes it much worse (crash rate 6% → 18%); adding an explicit floor beats both.

### `VALUE_FLOOR = 30_000_000` is unreachable and absolute floors don't transfer

**0% of assets clear 30M in the first 30 days** (Mirror 0%, Hinekora 5%), so `liq` never caps — it degenerates
into raw volume weighting. Worse, the value scale shifts per league: median daily value at day 15 runs
16,966 → 47,548 across leagues, p90 789k → 10.9M (14×). **A relative floor is the only one that transfers**, and
it never empties the board (0 dead days vs 99 at 30M).

### Rarity ≠ risk (owner steer, confirmed)

Because `valvol` is **value** traded, not unit count, the hard anchors clear a *relative* floor easily —
Mirror 93% of early days, Hinekora 93%, Divine 95%. Steadiness and turnover predict crash risk about equally,
so turnover was only ever a proxy; drawdown measures the intended thing directly.

### Tuning

`score = log(1+ret) + k·log(stab)` is a continuous, sign-safe dial. Production sits at ≈ k=2:

| k | basket | crash | blue chips | top-10 mdd |
|---|---|---|---|---|
| 0.5 | +0.249 | 7% | 0.69 | −31.7% |
| **2** | **+0.192** | **5%** | **1.28** | **−15.2%** |
| 3 | +0.136 | 5% | 1.45 | −14.0% |
| 6 | +0.115 | 5% | 1.59 | −14.0% |
| *production* | *+0.193* | *5%* | *1.70* | *−22.7%* |

**k=2 reproduces production's crash rate and blue-chip mix with better drawdowns and no sign bug.** Safety
saturates at k=3 (mdd flat at −14.0% thereafter) so higher k pays return for nothing. Note production picks
*more* blue chips but with *worse* drawdowns — `liq` selects for big, not steady; the two are not the same.

A **−40% drawdown cap** does the job k=3 did (drops the one volatile pick) while *improving* excess return
(+0.250 vs +0.226). It is the tightest cap that spares the anchors — at −35% Mirror is excluded 25% of days and
Hinekora 27%; at −40% both are 0%. Tighter caps (−20%, −15%) score better on return but *worse* on crashes
(8%, 12%) because eligibility collapses to 7–10% and "hasn't moved yet" ≠ "safe". Chaos Orb is cut at every
level — correct, it deflates against Divine by design.

## The fix (decided 2026-09-20)

```
floor:  top 50% of the day's traded value, AND n >= 4 days      (replaces VALUE_FLOOR + the liq multiplier)
cap:    exclude max-drawdown worse than -40%                    (holdscore.MDD_CAP)
score:  log(1 + ret) + CAUTION_K * log(1 + mdd)                 (sign-safe; default 2.0 matches today)
```

**CAUTION is a user dial** (owner directive). `CAUTION_K` is exposed as a slider on the Hold page over
`CAUTION_RANGE = (0.0, 6.0)`, persisted as the `hold_caution` setting and passed through `GET /api/hold?k=`.
0 = rank on return alone; 6 = favour the steadier asset. It is named for what the *user* is setting, not for a
property of an asset — the board already has a drawdown column, so "Stability" on a slider would read as a
filter on it. Monotonicity is asserted at **every** slider position, so the dial can change what the board
prefers but can never reintroduce the sign bug.

Covered by `backend/tests/test_hold_score.py` (33 tests, incl. two over the whole production DB). The suite was
teeth-checked: restoring `ret * conf * stab` turns 5 of them red, one of which catches a real inversion in live
data.

Verified on Forbidden Rites day 16: Mirror, Hinekora's Lock and Divine all kept, 108/297 eligible, the one
volatile pick (Omen of the Hunt, −41.7%) removed.

Still open, **not** part of this change:
- **The forecast column.** Either integrate it into the score before ranking (AQR: integrating *"avoid[s] stocks
  with offsetting style exposures"* — literally this bug) or rename the board to describe what it measures.
- **The band.** At minimum sample SD; properly a prediction interval, or suppress the cell (NCHS-style).
- **Post-day-30 behaviour.** The signal is gone by then and the board does not say so.

## Verification status of the sources

Verified verbatim from the source text or pinned library source: Lin/Louis 2006 (both quotes), Goldstein &
Spiegelhalter 1996, OECD/JRC Handbook, CFA Institute/Israelsen, empyrical `stability_of_timeseries` /
`calmar_ratio` / the `< 2 → NaN` idiom, quantstats `cpc_index` / `common_sense_ratio` / `autocorr_penalty`. All
small-sample arithmetic (prediction-interval multipliers, Kish ESS, `pstdev` ratios) independently recomputed and
matched to three decimals.

**Not independently verified** — do not quote without checking: Grinold (1994) formula body (paywalled),
Heston & Sadka verbatim, Joslyn & LeClerc wording (retrieval failed), Morningstar downside-capture definition
(403), Cheridito & Kromer (403), the NCHS primary thresholds (the MCHB restatement *was* verified).

Two research-process notes worth keeping: parallel agents **collided on scratchpad filenames** (an `oecd.txt`
that was actually a different paper), and extracted PDFs tripped `grep`'s binary detection — either failure would
have made correctly-sourced quotes look fabricated. Use `grep -a` and per-agent scratch dirs next time.
