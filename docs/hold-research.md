# Hold — research index

Everything known about how Hold ranks, why, and where the evidence lives. Start here before
changing `backend/app/holdscore.py`.

| Doc | What it holds |
|---|---|
| this file | the goal, today's diagnosis (2026-09-28), the smoke test, the 2026-09-28 measurements and literature |
| [`research/hold-research-recovered.md`](research/hold-research-recovered.md) | the 2026-09-13 design research, the owner's words on Hold, how the score evolved, the 2026-09-20 backtests, and **every source the old research cited** (§6, with verification status) — recovered from session transcripts after the scratchpad files were lost |
| [`research/hold-arena-2026-09-28.md`](research/hold-arena-2026-09-28.md) | the arena's four candidate designs, the judge's verdict, and every source they cited |
| [`bugs/2026-09-20-hold-ranks-against-its-own-forecast.md`](bugs/2026-09-20-hold-ranks-against-its-own-forecast.md) | the 0.3.2 sign-bug diagnosis and fix |
| [`bugs/2026-09-20-hold-open-items-handoff.md`](bugs/2026-09-20-hold-open-items-handoff.md) | the 0.3.3 forecast/arrow work and the measurement trap (gap ≥ 2) |

## The goal (owner)

Hold suggests good, **safe** places to park currency against inflation. In the owner's words:
"items rated to beat inflation over time. An asset that is good to park your currency in. Typical
examples are Hinekora's Locks, Mirrors, Omens of Whittling, Omens of Dextral Annulment" (2026-09-14);
"hold is retaining wealth -> directly related to combating inflation" (2026-09-15); "typically high end
omens top that list along with other expensive currencies" (2026-09-28). It must not over-weight items
that have just gone up.

Leagues are short, young economies, so real-world methods are adapted to them, not copied: lookbacks
in days, a fresh price-discovery phase each league, a common drift against Divine, and only four past
leagues to learn from.

## Diagnosis, 2026-09-28 (Forbidden Rites, league-day 24)

The score is `log(1 + ret) + k·log(1 + mdd)`, `ret` the 1/3/7-day return in Divine, `mdd` the
league's worst peak-to-trough drop, k ≈ 2.

1. **The drawdown is measured on raw daily closes; the return on smoothed ones.** `_metrics` smooths
   the return's endpoints with `_smooth` (3-day median) but computes `mdd` over the raw closes. Thin,
   expensive assets have noisy closes, so one-day blips read as crashes: Mirror −18.9% raw vs −7.7%
   smoothed, Hinekora's Lock −13.2% vs −2.5%, Omen of Light −23.3% vs −2.7%; Greater Chaos Orb −4.1% vs
   −0.5%. At k = 2 this sinks the owner's hedges (Mirror #46, Omen of Light #63).
2. **What decides the order flips with the horizon.** At 1d/3d the return is tiny, so the board is
   "smallest raw drawdown" — cheap, heavily traded crafting currency tops it (Greater Chaos Orb, Perfect
   Exalted Orb, Masterwork Rune). At 7d the return dominates, so recent spikes top it (Architect's Orb
   +77%, Perfect Flux +118%).
3. **Nothing measures store of value.** The 2026-09-13 design ranked 7d/30d/whole-league returns
   (whole-league weighted most); commit `f366684` moved Hold to 1/3/7d and `MAX_HORIZON_DAYS = 7` clamps
   the app's 14d choice to a 7-day board. League-long retention, price level and trend steadiness are
   in no term.
4. **Divine itself moved** (≈28 → ≈500 exalted this league), so early "rises" in Divine are partly the
   numeraire settling.

**Re-running the crash conclusions:** `ops/hold-diagnostics.py` — `signals` (does a warning sign flag
crashes, per league), `topten` (within Hold's own top 10), `floor` (the best crash percentile any list
could get) and `noise` (how much the crash-cell count moves by chance). Pure pieces tested in
`backend/tests/test_hold_diagnostics.py`.

## The smoke test — `ops/hold-backtest.py`

Replays Hold day by day through a league for every window the app offers (24h/3d/7d/14d): it builds the
board Hold shows FOR that window (since 2026-09-30; before, one board was reused for every window), holds
its top 10 in equal parts from t+2 for exactly that long, and grades the portfolio against `THRESHOLDS`: it must
out-earn holding every eligible asset, on most days; keep its value in Divine; crash (lose > 20%) at most
half as often as the eligible basket; settle (≤ 30% of names change day to day); and carry one of the
owner's named hedges most days. `--league all` grades the four past leagues as a holdout; `--scorer
file.py:fn` grades a candidate; `--show-day N` prints one day's board with outcomes. Exit 1 on a miss.

Production, 2026-09-28, current league: **fails every horizon** — churn 32–49%, the owner's hedges on
the list 0–22% of days, and at 14d the picks crash as often as the basket (ratio 1.05).

## The ranking, 2026-09-28 — `holdscore.hold_rank`

Five signals on smoothed prices, each ranked against the day's eligible board and averaged with
fixed weights:

| signal | weight | what it is |
|---|---|---|
| kept | ½ | value kept since league-day 7, stopping 3 days ago (a last-days jump doesn't count) |
| trend | ½ | slope × R² of log price over the 14 days before the last 2 — with kept, one "climb" signal |
| dip | k / 2 | worst drop since league-day 7 (the Caution slider; default k = 2 → 1) |
| price | 1 | log price in Divine — the most expensive fifth crashed about half as often, every league |
| record | 1 | in earlier leagues' days 7–60, the share of 14-day holds that kept 80% of their value |

Before league-day 7 kept and trend don't rank. A signal an asset can't be measured on yet is left out
of its score (never counted as 0 — that made the order depend on arbitrary ties); the record is the
exception once earlier leagues exist: no record is a neutral rank. The list settles (mean of the last
3 days). The eligibility gate (value floor, 4 days, −40% cap) is unchanged. ~~The horizon sets the return
column and the forecast, not the order.~~ Superseded 2026-09-30: the window is the holding period and the
ranking answers it — see "The window is the holding period" at the end of this file.

## Arena, 2026-09-28

Four designs (Opus 5.5 each; two first runs on Fable died on a usage limit and were re-run on Opus),
same brief, graded by `ops/hold-backtest.py`; an Opus cross-judge scored them independently. Each
candidate's rationale and sources: [`research/hold-arena-2026-09-28.md`](research/hold-arena-2026-09-28.md).

| candidate | idea | holdout vs the first 2026-09-28 ranking (16 past-league cells, better/worse) |
|---|---|---|
| 1 | Sharpe-style "steady", safe-haven, same-phase crash record (neutral if none) | return 10/6, crash 10/4, owner 0/4 — the only one to push Perfect Flux / Emergent Possibility out of the top 10 |
| **2 (base)** | cross-league **survival record**; kept + trend count once | return 11/5, crash **11/1**, owner **4/0** |
| 3 | safe-haven + cross-league track (no record ranks last) | return 13/3, crash 7/4 (worse every horizon in Rise of the Abyssal: 60% of its board was new) |
| 4 | efficiency-ratio steady, safe-haven, forecast, traded-value depth | return 6/10, crash 7/9, owner 0/8 |

Judge: 2 (18/25) > 1, 3 (17) > 4 (13); base = 2, the smallest change with the best holdout.

**Grafts.** From 3: the record reads only a past league's days 7–60 — candidate 2 read every day of
earlier leagues, and Runes of Aldur is still running, so replaying Forbidden Rites saw Aldur's future
(and the record could never settle in a long-running app). Closing that *improved* it. From 1: no
record is a neutral rank instead of a left-out signal.

**Rejected, measured.** Requiring two leagues of record (the judge's suggested graft; it would drop
Emergent Possibility and Perfect Flux out of the top 10): fails the current league's 14d beat and
halves 7d/14d return, holdout return 8/8. Candidate 3/1's safe-haven signal: crash 11/0 but churn worse
in 16/16 for one more signal. Candidate 1's Sharpe "steady" in place of trend: return 9/7. The forecast
`_predict` and traded-value depth (candidates 1, 2 and 4 measured both hurting). A hand-listed omen
bonus (every candidate declined it).

**Result.** Current league: passes every horizon — vs the eligible basket +3.1 / +8.7 / +21.3 / +54.0
points (24h/3d/7d/14d; the first 2026-09-28 ranking: +1.6 / +5.5 / +12.0 / +11.8), crash ratio 0 at every
horizon, the owner's hedges on the list 100% of days, churn 14%, chase 3%. Holdout vs the first
2026-09-28 ranking: return better in 15/16 cells, crash ratio 11/1, owner 4/0, churn 4/4, chase 4/10
(chase +1–2 points, far under the limit). Day-24 7d board: Her Declaration, **Emergent Possibility**,
Raven-Touched Shard, **Perfect Flux**, Hinekora's Lock, Aldur's Legacy, Seraph's Heart, Uul-Netol's
Embrace, Uhtred's Exodus, Omen of Light, Mirror, Garukhan's Resolve, … Omen of Dextral Annulment #14.
Emergent Possibility and Perfect Flux stay: each held its value through an earlier league, and every
rule that demotes them measured worse. That is the owner's call to make, not a tuning knob.

**Items with only one earlier league (owner, 2026-09-28).** Many top items entered the data in Runes of
Aldur, so their whole record is one debut league: Emergent Possibility, Perfect Flux, Her Declaration,
Raven-Touched Shard, Aldur's Legacy, Seraph's Heart. ("First seen" is partly crawl coverage — Dawn of the
Hunt tracked 166 items.) Measured whether a one-league record deserves less trust (walk-forward, every
target league, league-days 7–44, 14d hold from t+2; `rec_by_n.py` in the session scratchpad):

| record from | good record (≥ 0.9): crash | weaker record: crash |
|---|---|---|
| 1 earlier league (1,673 obs) | 12% | 24% |
| 2+ leagues, pooled (1,896 obs) | 16% | 17% |
| 2+ leagues, most recent only | 14% | 21% |
| 2+ leagues, oldest only | 13% | 20% |

A one-league record separates crash risk *better* than a pooled one. Three ways to act on the concern,
each graded on every league against the shipped ranking: discounting the record by n/(n+1) (one league
counts half) — holdout return worse in 10/16, crash worse in 10/16, board barely moves (Emergent #5,
Flux #6); the most recent league only — fails the current league's owner check; a GAMMA-weighted mean of
per-league records — neutral (return 4/4, crash 1/2), same board. None adopted. A one-league record is a
smaller sample and a debut league is its own regime; the data so far does not show it misleading, but
it rests on one league per item — revisit when Forbidden Rites becomes the second.

**Threshold question (all candidates and the judge).** No scorer meets crash ratio ≤ 0.50 on a 14d hold
in any past league: early in a league the whole basket crashes 40–50% of the time, and the 14d choice
ranks on a 7-day board. A per-phase threshold would read more honestly; left unchanged.

## Improvement loop, 2026-09-28

Goal (owner: generalize to any new league, don't overfit one): over all five leagues × four horizons
(20 cells, each league scored with only earlier leagues), reach beat ≥ 0.55 in 18/20, crash ratio ≤ 0.75
in 18/20 and never > 1.0, kept ≥ 0.75 in 14/20, list checks 20/20, and keep passing the current-league
smoke test. A change is accepted only if ≥ 80% of the leagues it moves get better (at least 2), none gets
clearly worse, and the scorecard gains. Stop on target, after 3 straight iterations without an accepted
gain, or after 10. Beta 0.3.6-beta.10 telemetry was clean before it started (win32: seed kept, crawl
complete, no T0; `[hold] day=24 … top5=Her Declaration; Emergent Possibility; Raven-Touched Shard;
Perfect Flux; Hinekora's Lock`, identical to the backtest).

Baseline (hold_rank as shipped in beta.10): beat 14/20, crash ≤ 0.75 13/20, crash ≤ 1.0 19/20, kept 11/20,
list checks 20/20. Its top 10 beat the basket by a wide margin in league-days 1–14 of every league and
fall behind it from ~day 15 (Fate of the Vaal 14d, days 15–30: −38 points).

| # | change | result | verdict |
|---|---|---|---|
| 1 | drop kept/trend after league-day 30 (measured to stop predicting there) | scorecard ±0; Runes better, Fate of the Vaal worse | rejected |
| 2 | price ranks only through league-day 14 (7d IC +.21/+.12 early, −.09 days 15–30) | +4 cells (beat 17/20, crash 15/20); Fate 14d +15 → +24 points, Runes 14d +3.6 → +9.6; but Rise of the Abyssal's crash ratio worsens at every horizon (24h 0.38 → 0.56) and Runes' owner coverage drops 100% → 81% | rejected (Rise regresses) |
| 3 | the record reads the same league phase (±5 days) instead of days 7–60 | −2 cells; three leagues worse | rejected |

**Stopped after 3 iterations without an accepted gain** (the agreed rule). The lead worth pursuing: price
helps safety early and costs return from mid-league (iteration 2) — but in Rise of the Abyssal it was
still doing safety work mid-league, so dropping it outright trades one league's safety for others'
return. A phase-aware treatment of price needs a principled reason for *how much* it should fade, not a
weight picked to pass these five leagues.

## Regimes, 2026-09-28 (loop 2)

Hold won the first two weeks of every league and trailed the eligible basket from ~day 15. The fix is
to rank each league **regime** its own way.

**Detecting the regime from the market, not the calendar** (`backend/app/leagueregime.py`). Two
signals, each against the league's own history, boundaries from what they measure:
- *persistence* — cross-sectional Spearman between each liquid item's return over the last 3 days and
  the 3 days before (weekly median). Positive while prices are still being discovered (a re-priced item
  keeps going), ≤ 0 once they are found (moves are noise and partly reverse). EARLY ↔ MID at 0.
- *activity* — traded value in Divine (weekly median) over its running peak; LATE as it falls past half.
Memberships blend (early = R·a, mid = R·(1−a), late = 1−R, weekly mean). Detected EARLY→MID: Forbidden
Rites 19, Runes of Aldur 24, Fate of the Vaal 28, Dawn of the Hunt 30, **Rise of the Abyssal 32** (the
league the fixed day-14 cut broke); MID→LATE 57–133. Rejected inputs: cross-sectional dispersion (no
common boundary; rises again late), Divine velocity (doesn't track phase), new-item entry (done by day
2–4). Sources: Lo & MacKinlay 1988 (variance ratio), Jegadeesh 1990 (reversal in settled markets),
Cooper, Gutierrez & Hameed 2004 (momentum depends on market state), Dobrynskaya (2–4 weeks of momentum
in young markets), Page 1954 / Adams & MacKay 2007 (change-point methods, not adopted: tuned thresholds
or hazard models); community: arpgseasons.com league cycle (secondary).

**What works in each regime** (walk-forward, each league with only earlier leagues, per-league sign
agreement, 7d/14d holds):
- *Early (1–14, 5 leagues)*: the 2026-09-28 set is best — record (IC .46/.50, 4/4), price (safest top 10,
  crash ratio .41), dip; trend and recent return have spike tops early.
- *Mid (15–45, 4 leagues)*: **price flips** (IC −.11, 0/4) and the early set is ≈ 0. Positive in 4/4 on
  return and safety: trend, kept, haven (safe-haven reading), traded-value trend, Sharpe-style
  steadiness, near-peak. The basket's mid lead came from cheap items (bottom two price fifths +17.5 points
  at 14d), Uncut Spirit Gems and Fate fragments, concentrated in a few items a day.
- *Late (46+, 3 leagues, small boards)*: nothing is 3/3 on both; momentum reverses; price and haven
  protect.

**The ranking** (`holdscore.REGIME_SETS`, blended by the memberships):
early = kept ½, trend ½, dip, price, record · mid = kept ½, trend ½, haven, volume trend, steadiness,
dip, record · late = price, haven, efficiency ratio, dip.

**Result vs the first 2026-09-28 ranking** (20 cells): beat ≥ 0.55 **14 → 19** (target 18 met), crash
ratio ≤ 0.75 13 → 14, kept 11 → 11, list checks 20/20; Fate of the Vaal and Runes of Aldur better (their
14d beat 0.27 → 0.37 and 0.39 → 0.61), Dawn unchanged (all its graded days are early), Rise and Forbidden
Rites within noise (≤ 0.2%). Current league passes every horizon.

**After regimes (loop stopped: 3 straight iterations without a gain).** Near-peak (price / its running
peak) in the early and mid sets — 0 cells, Fate and Rise clearly worse. The record in the late set — no
effect (late graded days are rare). The record matched to the regime (holds from past-league days the
detector gave the same label) — −3 cells, Runes clearly worse.

Where it stands (20 cells): beat 19/20 (target 18 ✓), crash ≤ 0.75 14/20 (18), crash ≤ 1.0 19/20 (20),
kept 11/20 (14), list checks 20/20 ✓, current league passes ✓. The remaining misses: **Dawn of the Hunt,
4 cells** — the first league: no earlier league to learn from, 8 graded days, all in price discovery; even
"most expensive first" crashes more there (0.76–1.17), so these cells look unreachable for any ranking;
**Runes of Aldur kept, 4 cells** — its long late league deflates nearly everything against Divine;
Fate of the Vaal 14d (crash 0.90, beat 0.32) and Runes 14d crash 0.96 — the basket's mid-league lead there
is a few cheap multi-baggers a safety list is built to skip. A per-regime target (the owner's open
threshold question) would read these more honestly than one bar for every day.

**Loop record.** Rejected: the −40% eligibility cap on the smoothed dip instead of the raw whole-league
drawdown (board grows, Runes 21–195 items vs 21–135, but kept 11 → 8 and Dawn/Fate worse — the items it
kept out do lose value); the first regime blend (mid set without kept: +5 cells but 2 of 4 moved
leagues better). **Rule change made during the loop:** a league counts as "moved" only when its value
changes by more than 0.005 (half the 0.01 "clearly worse" line); smaller is noise. Under the original
1e-6 line the accepted change read as "2 of 4 moved leagues better" with Rise −0.0023 and Forbidden Rites
−0.0007.

## Research for the remaining gaps, 2026-09-28

Web research after the regime loop (reading status: **[P]** primary text read · **[A]** abstract/index only ·
**[S]** secondary · **[Press]** press release). Proposals ranked by expected impact vs overfitting risk;
each is testable with `ops/hold-backtest.py --scorer`. None implemented yet.

1. **Divine is a candidate (late league).** An absolute trend filter: in the late membership an item keeps
   its slot only while its 14-day smoothed Divine slope (skip 2) is positive; failed slots are held in Divine
   (return 0). Evidence: time- vs cross-sectional momentum differ mostly by the net-long / cash decision
   (Goyal & Jegadeesh [A]); moving-average filters to cash cut drawdowns (Faber 2007 [S]; Antonacci [S]);
   trend following held up in 8 of 10 largest crises (Hurst, Ooi & Pedersen [A]); cross-sectional momentum
   crashes after declines (Daniel & Moskowitz 2016 [A]). No new parameters. Targets Runes of Aldur's kept cells.
2. **Price-neutral mid ranking.** Rank mid signals within price terciles and fill the top 10 across them (no
   price weight, no item list), with a lottery veto in the cheap tercile (top decile of max daily return or
   of top-2-day share of the 14-day gain). Evidence: cheapest coins out-earn dearest in a young asset class
   (Liu, Tsyvinski & Wu 2022 [P]); common CS skins out-earn rare ones (Dobrynskaya & Strelnikov 2026 [Press];
   Reichenbach 2025 [P]); lottery-like assets underperform (Bali, Cakici & Whitelaw; Boyer, Mitton & Vorkink
   2010 [A]; Birru & Wang 2016 [A]) — but MAX is positive in crypto (Ozdamar et al.), hence a veto, not a
   signal. Constraints and 1/N beat fitted weights (Jagannathan & Ma 2003 [A]; DeMiguel et al.).
3. **Charge execution costs in the backtest; cap by depth.** Roll (1984) / Abdi & Ranaldo (2017) spread from
   closes [A]; Amihud (2002) illiquidity [A]; fees make short-term skin trading unprofitable (Reichenbach [P]).
   Tests whether the basket's mid lead from cheap multi-baggers survives costs.
4. **Downside beta in the late set.** β⁻ over 21 days, rank low (Ang, Chen & Xing 2006 [A]; Clarke, de Silva
   & Thorley 2006 [A]). Distinct from low volatility, which runs backwards here.
5. **Class shrinkage for thin records.** record* = (n·r + m·r̄_class)/(n + m) with m from leave-one-league-out
   variance (Efron & Morris 1975 [A]). Small expected effect; the first league still has nothing to pool.
6. **A stronger acceptance test.** Hansen SPA / White Reality Check over every variant tried, league-block
   bootstrap, deflated metrics (White 2000; Hansen 2005; Harvey, Liu & Zhu 2016; Bailey & López de Prado
   2014 [A]); factor timing is hard to do robustly (Asness et al. 2017 [A]); equal-weight combining wins in
   small samples (Smith & Wallis 2009; Rapach, Strauss & Zhou 2010 [A]).

**Tested (against the regime ranking, 20 cells; all rejected, nothing kept):**

| # | experiment | result |
|---|---|---|
| 1 | trend filter to Divine (failed slots held in Divine), late-dominant / from mid on | 0 / −1 cells, one league moved — Hold's top picks are almost always still trending up, so the filter rarely fires |
| 2 | price-neutral mid ranking (price terciles, round-robin, MAX14 veto in the cheap tercile), mid-dominant / from mid on | beat 19 → 20/20 and Fate and Runes better, but crash ≤ 0.75 14 → 13: net 0 / −1 |
| 4 | downside beta in place of the efficiency ratio (late) | −2 cells, Runes clearly worse |
| 5 | record shrunk toward its category mean (prior = RECORD_MIN_WINDOWS) | −1 cell; Fate, Rise and Forbidden Rites clearly worse |

#2 is the nearest miss: it buys return mid-league at one crash cell. #3 (costs) and #6 (a stricter
acceptance test) change how Hold is graded, not what it ranks, and were not run.

Game economies: an item sink raised luxury prices 7–14% with no volume effect (OSRS; Hogan-Hennessy,
Xenopoulos & Silva 2022, §4.1–4.2 [P]); new CS items fall hard for months, then recover (Reichenbach [P]);
EVE PLEX −20% over a year [S]. No data-backed PoE2 retention study exists (searched again); community
advice "keep wealth in the highest denomination" matches proposal 1.

Sources (full list): Liu, Tsyvinski & Wu JF 77(2) doi:10.1111/jofi.13119 https://www.nber.org/papers/w25882 ·
Dobrynskaya & Strelnikov QJF doi:10.1142/S201013922640001X https://www.eurekalert.org/news-releases/1113802 ·
Reichenbach FRL 83:107670 https://depositonce.tu-berlin.de/items/f0f81c28-3c67-496e-820e-93de53e2b8ab ·
Hogan-Hennessy et al. https://arxiv.org/abs/2210.07970 · Scholten et al. 2019 https://arxiv.org/abs/1905.06721 ·
Goyal & Jegadeesh doi:10.2139/ssrn.2610288 · Faber 2007 https://papers.ssrn.com/sol3/papers.cfm?abstract_id=962461 ·
Antonacci (secondary) https://awealthofcommonsense.com/2015/07/my-thoughts-on-gary-antonaccis-dual-momentum/ ·
Hurst, Ooi & Pedersen https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2993026 ·
Daniel & Moskowitz JFE 122(2) https://www.nber.org/papers/w20439 · Ang, Chen & Xing RFS 19(4) https://www.nber.org/papers/w11824 ·
Clarke, de Silva & Thorley JPM 33(1) doi:10.3905/jpm.2006.661366 · Jagannathan & Ma JF 58(4) https://www.nber.org/papers/w8922 ·
Boyer, Mitton & Vorkink RFS 23 https://academic.oup.com/rfs/article-abstract/23/1/169/1578688 ·
Birru & Wang JFE 119(3) https://ideas.repec.org/a/eee/jfinec/v119y2016i3p578-598.html ·
Amihud 2002 https://www.cis.upenn.edu/~mkearns/finread/amihud.pdf · Abdi & Ranaldo RFS 30(12) https://academic.oup.com/rfs/article/30/12/4437/4047344 ·
Efron & Morris JASA 70(350) https://www.tandfonline.com/doi/abs/10.1080/01621459.1975.10479864 ·
Bayesian hierarchical factor investing https://arxiv.org/abs/1902.01015 (index only) ·
Asness et al. JPM 43(5) https://www.aqr.com/Insights/Research/Journal-Article/Contrarian-Factor-Timing-is-Deceptively-Difficult ·
Smith & Wallis OBES 71(3) https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1468-0084.2008.00541.x ·
Rapach, Strauss & Zhou RFS 23(2) https://academic.oup.com/rfs/article-abstract/23/2/821/1604687 ·
White 2000 https://users.ssc.wisc.edu/~bhansen/718/White2000.pdf · Hansen 2005 https://papers.ssrn.com/sol3/papers.cfm?abstract_id=264569 ·
Harvey, Liu & Zhu RFS 29(1) https://www.nber.org/papers/w20592 · Bailey & López de Prado https://ssrn.com/abstract=2460551 ·
EVE PLEX (blog) https://nosygamer.blogspot.com/2026/07/the-june-2026-monthly-economic-report.html.

## Academic review, round 3, 2026-09-28

Two parallel reviews (Opus), academic sources only, skipping what the doc already cites or tested.
**[P]** primary text read (quotes verbatim with page) · **[A]** abstract only. None implemented yet.

**The grading itself is biased against a 10-item list.** The backtest scores both the top 10 and the
basket buy-and-hold, so the basket's lead is skew plus a cheap-item tilt, not rebalancing alpha
(Plyakha, Uppal & Vilkov 2012 [P]: equal weight's alpha "arises … from the monthly rebalancing"). With
right-skewed payoffs a skill-free 10-item draw beats the basket mean less than half the time (Bessembinder
2018 [P]: "the best-performing 4% of listed companies explain the net gain for the entire US stock market";
portfolios of 25 beat the market in 48.7% of annual outcomes). So "beat ≥ 0.55" and the crash ratio carry a
handicap that is largest mid-league. Proposed: grade against ~2,000 random 10-item portfolios per day
(percentile of the top 10, random-10 beat rate as the null) — the per-regime targets the doc already asks for.

**Proposals, ranked (impact ÷ overfit risk):**
1. *Random-10 null* for grading (above). No ranking risk.
2. *Placebo critical values* — permute item labels within each day, push placebo signals through the same
   "keep the best k" rule ~200 times; the distribution of cells gained is the bar a real change must clear
   (Novy-Marx 2015 [P]: combining the best k of n signals is nearly as biased as picking the best of n^k;
   Hou, Xue & Zhang 2020 [P]: 64–85% of anomalies fail to replicate).
3. *Cheap among non-junk, mid-league* — screen out items below the median of the mid composite, then rank
   survivors by cheapness (price's measured mid-league sign). Quality controls rescue the size effect
   (Asness, Frazzini & Pedersen QMJ [P]; Asness et al. 2018 "Size matters, if you control your junk" [P]);
   anomalies live mostly in the short leg (Stambaugh, Yu & Yuan 2012 [P]). First a diagnostic: is the
   composite's power in avoiding the bottom third rather than picking the top?
4. *Signals switch on and off by their own recent performance* — within the league, keep a signal only while
   its top-minus-bottom-third forward return over the last 7–14 completed days is positive (Ehsani &
   Linnainmaa 2022 [P]; Gupta & Kelly 2019 [A]; Arnott, Kalesnik & Linnainmaa 2023 [A]). Needs no past league.
5. *Price-to-activity valuation* — Δ14 log price − Δ14 log traded volume per item (rank low), and at the
   market level the basket price over total volume as a late-league timing signal (Borri, Liu & Tsyvinski
   2022 NFTs [P]: the index-to-transaction ratio predicts −19.1% at 5 weeks per s.d., R² 20.6%).
6. *Breadth-gated regime* — while the share of rising items is above earlier leagues' median, let cheap items
   in (experiment #2's price-neutral ranking); below it, weight price (Franses & Knecht 2016 stamp bubble [P]:
   cheap abundant stamps join the bubble and crash first; rare ones suffer less).
7. *Volume-conditioned spikes* — a jump on high volume in a liquid item reverses; in a thin item it may
   continue (Campbell, Grossman & Wang 1993 [P]; Llorente et al. 2002 [P]).
8. *Stress-only haven over a recent window* — the basket's worst-decile days in the last 14–21; havens are
   short-lived (Baur & Lucey 2010 [P]); no asset hedges broad inflation well (Bekaert & Wang 2010 [P]) — an
   argument for a per-regime "kept" target, not a ranking fix.
9. *Next-league announcement as a lockup expiry* — a known end date drives selling (Field & Hanka 2001 [A];
   the Glitch shutdown: 50% of items fell and 12% rose in the last four weeks, Drachen et al. [P]). Needs the
   announcement date as calendar data.

Corroborating, not new signals: masterpieces and expensive NFTs underperform (Mei & Moses 2002 [P]; Borri
et al. [P]) — the same price trade-off; new game worlds settle their price structure fast (Castronova et al.
2009 [A]; Morrison & Fontenla 2013 [A]) — cross-sectional signals work even in a first league; early-season
betting lines are biased (Baryla et al. 2007 [A]). Not recommended: volatility-managed exposure (Cederburg
et al. 2020 [P]: fails out of sample from structural instability); ML interaction models (five leagues are
too few independent periods).

Sources: Bessembinder JFE 129(3) doi:10.1016/j.jfineco.2018.06.004 https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2900447 ·
Plyakha, Uppal & Vilkov doi:10.2139/ssrn.2724535 · Stambaugh, Yu & Yuan JFE 104(2) doi:10.1016/j.jfineco.2011.12.001 ·
Asness, Frazzini & Pedersen QMJ https://www.aqr.com/-/media/AQR/Documents/Insights/Working-Papers/Quality-Minus-Junk.pdf ·
Asness et al. JFE 129(3) "Size matters, if you control your junk" · Novy-Marx https://www.nber.org/papers/w21329 ·
Hou, Xue & Zhang RFS 33(5) https://www.nber.org/papers/w23394 · Ehsani & Linnainmaa JF 77(3) https://www.nber.org/papers/w25551 ·
Gupta & Kelly JPM 45(3) doi:10.3905/jpm.2019.45.3.013 · Arnott, Kalesnik & Linnainmaa RFS 36(8) https://academic.oup.com/rfs/article-abstract/36/8/3034/6988043 ·
Baur & Lucey doi:10.1111/j.1540-6288.2010.00244.x · Bekaert & Wang Economic Policy 25(64) · Conlon & McGee FRL 35 doi:10.1016/j.frl.2020.101607 ·
Moreira & Muir JF 72(4) https://www.nber.org/papers/w22208 · Cederburg et al. JFE 138(1) · Borri, Liu & Tsyvinski https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4052045 ·
Franses & Knecht Empirical Economics 50(4) doi:10.1007/s00181-015-0974-3 · Mei & Moses AER 92(5) doi:10.1257/000282802762024719 ·
Campbell, Grossman & Wang QJE 108(4) https://academic.oup.com/qje/article-abstract/108/4/905/1899978 ·
Llorente, Michaely, Saar & Wang RFS 15(4) doi:10.1093/rfs/15.4.1005 · Drachen et al. https://arxiv.org/abs/1603.07610 ·
Field & Hanka JF 56(2) doi:10.1111/0022-1082.00334 · Baryla et al. FRL 4(3) https://ideas.repec.org/a/eee/finlet/v4y2007i3p155-164.html ·
Castronova et al. New Media & Society 11(5) doi:10.1177/1461444809105346 · Morrison & Fontenla Empirical Economics 44 doi:10.1007/s00181-012-0567-3 ·
Dobrynskaya & Kishilova (LEGO) https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3291456 · Dimson, Rousseau & Spaenjers JFE 118(2) https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2321573.

## Loop 4 — a fair yardstick, 2026-09-28

**Grading added** (`ops/hold-backtest.py` `random_null`, tested in `backend/tests/test_hold_backtest_null.py`):
each graded day the top 10's percentile among 2,000 random 10-item lists from the same eligible board, on
return (higher is better) and crash share (lower is better). A skill-free list sits near 50; the basket
mean is the wrong bar when a few winners carry it (Bessembinder 2018). Existing metrics unchanged.

**Chance bar.** Twenty runs with a random signal added to every regime set gained −5 … +1 cells on the
yardstick scorecard, so a real change must gain at least 2.

**Finish line:** return percentile ≥ 60 in 16/20 cells, crash percentile ≤ 40 in 16/20, list checks
20/20, current league passes. **Baseline (regime-aware hold_rank): 13/20 and 8/20.** By league the top 10
sits at the 57–88th return percentile and the 15–59th crash percentile — clearly better than random in
Rise of the Abyssal and Forbidden Rites, marginal in Fate of the Vaal and Runes of Aldur, and Dawn of the
Hunt's 14d crash percentile is 59 (worse than random).

| # | change | result | verdict |
|---|---|---|---|
| 1 | cheap among non-junk, mid-league (quality screen = the Hold score's median, then cheapest first) | +4 cells (return 17/20), but Forbidden Rites and Rise clearly worse, owner 20 → 16 | rejected |
| 2 | signals switch themselves on/off by their own last-14-days in-league performance | +5 cells (return 18/20), lists intact, none clearly worse — but the gain is all Runes of Aldur (+0.077), Forbidden Rites −0.007: 1 of 2 moved leagues better | rejected (single-league) |
| 3 | price-to-activity valuation in the mid and late sets | 0 cells, Runes clearly worse | rejected |

Stopped: 3 straight iterations without an accepted change. Crash percentile (8/20) is the stubborn target:
no candidate moved it. #2 is the one to revisit when Forbidden Rites has run long enough to show whether
its Runes-only gain generalizes.

## Loop 5 — crashes, 2026-09-28

Pattern: find the weakest spot, one hypothesis, one test; keep what passes (yardstick gain ≥ 2 cells —
the chance bar — ≥ 80% of moved leagues better, none clearly worse, lists intact, current league passes);
research when stuck. Owner's caution: some crashes are unpredictable (patches, bugs, new tech, a
replacement, randomness), so a crash-side gain must survive removing each league's three worst
market-wide crash days.

**Where Hold's crashes come from.** Its top 10 already crash half as often as the eligible board (9% vs
19% over 7 days); the picks that did crash had stalled the week before (mid-league 7-day return +15% vs
+33% for picks that held) with trading slowing. Crash rates track the regime, not how long an item has
traded.

| # | hypothesis → change | result |
|---|---|---|
| H1 | stalls are invisible to `kept` (skips 3 days) → last-7-day return in the mid set | 0 cells, Rise clearly worse — rejected |
| H2 | a crash starts as a fall → veto items whose price fell over the last 3 days | −5 cells, 4 leagues worse (3-day falls rebound) — rejected |
| — | **research** (crash prediction; sources below). Diagnostic, per league, AUC for "falls below 80% of entry within the hold": downside volatility flags crashes **5/5** leagues (7d) and 4/4 (14d); run-up, acceleration and volume-backed gains are the *opposite* sign (0/3) — the equity bubble literature doesn't transfer; an illiquidity shock is mixed (2/4) | |
| H3 | downside-volatility veto (top fifth of the board out of the top 10, ≤ 3 a day, refill) | +3 cells; Dawn, Fate, Runes better; Rise clearly worse — rejected |
| H4 | …only once prices have settled | +3; Rise still worse — rejected |
| H5 | low downside volatility as a mid/late signal instead of a veto | +1; Rise and Runes worse — rejected |
| — | **audit**: in Rise the veto removed Hinekora's Lock, Mirror and Reliquary Keys — thin, noisy both ways — which then rose +40% (median); their refills rose +1% and crashed more. Downside volatility confuses thin-market noise with a slide. | |
| H6 | down-vs-up volatility (DUVOL: symmetric noise ≈ 0, a slide falls harder than it rises) veto, always | +5; Fate and Runes better, Forbidden Rites and Rise worse — rejected |
| **H7** | **DUVOL veto only once prices have settled** | **+5 cells (return 13 → 17/20 ✓, crash 8 → 9/20); Fate, Rise, Runes better; none worse; survives dropping each league's 3 worst crash days (+3, same leagues); current league passes — ACCEPTED** |

Shipped as `holdscore._duvol` / `_crash_flags` / `_apply_veto` (VETO_TOP 10, VETO_MAX 3, VETO_QUANTILE 0.8,
VETO_DAYS 14), after `_hold_scores`, only when the regime is no longer mostly early. The first port let a
flagged item just below the list take a freed slot (shipped scored +2, not +5); the "shipped equals the
accepted experiment" check caught it, and `_apply_veto` now rebuilds the order (kept, refills, rest).

**After H7 (loop stopped: two research rounds in a row without an accepted change; 13 changes tested,
1 accepted).** At a 24h hold the eligible board crashes 1–5% (no crash at all on 28–67% of days), so crash
percentiles tie near 50. *Correction, measured exactly afterwards* (best possible = 50 × P(a random 10 from
the day's board has zero crashes), averaged over graded days): only **3** 24h cells are out of reach for any
list (Fate of the Vaal 42.3, Runes of Aldur 42.3, Forbidden Rites 43.8); Dawn 24h (30.0) and Rise 24h (37.9)
are reachable — so 17/20 cells are reachable and the original 16/20 target was possible. My first estimate
("every 24h cell is unreachable") was wrong. Every 3d/7d/14d cell has large headroom (best possible 0–29 vs
Hold's 21–60).

| # | hypothesis → change | result |
|---|---|---|
| H8 | late boards are too small → cap on the smoothed dip (re-graded on the yardstick) | −5; Fate, Rise, Runes worse — rejected |
| H9 | downside-vol residual after thinness, added to the veto | −3; three leagues worse — rejected |
| H10 | early relative 3-day stall veto | −4; Dawn, Rise worse — rejected |
| — | **research round 2** (early-life crashes: Miller 1977 [P]; Ritter & Welch 2002 [P]; Purnanandam & Swaminathan 2004; Krigman, Shaw & Womack 1999; Dufwenberg, Lindqvist & Moore 2005; Smith, Suchanek & Williams 1988 [A]). Diagnostic: items **overvalued vs their own past leagues crash less** (AUC 0.40–0.48, 0/4) and **big early gainers crash much less** (0.27–0.40, 0/5) — the IPO pattern doesn't transfer; winners keep winning early. Noise collapsing and turnover fading near the high: AUC ≈ 0.50 (no signal). | |
| H11 | early veto of the laggards (bottom fifth of gain since day 3) | fires almost only in Dawn (the top 10 has few laggards); −5 — rejected |
| H12 | early set: price counts double | −3; four leagues worse — rejected |
| H13 | veto without the 3-a-day cap | no effect (more than 3 flagged in a top 10 is rare) — rejected |
| — | **research round 3** (settled/late: Daniel & Moskowitz 2016 [P]; Kelly & Jiang 2014 [P]; Ang, Chen & Xing 2006 [P]; Acharya & Pedersen 2005 [P]; Karolyi, Lee & van Dijk 2012 [P]; Coval & Stafford 2007 [P]; Llorente et al. 2002 [P]; Hou 2007; Field & Hanka 2001 [A]). Diagnostic: a fall on heavy traded value — AUC 0.34/0.46/0.55 (mixed); lagging its most-correlated peers — 0.50 everywhere. Not built. Late days are almost all small boards (≤ 30 items; Runes late small-board crash percentile 57): a top 10 of ≤ 30 overlaps any random 10 heavily, so the yardstick can't separate them much. Crash prediction is weak even in rich equity data (crash-skewness R² 0.03–0.08, Chen, Hong & Stein Table 2). | |

Two last tests after the stop (the budget's final two): H14, a 7-day down-vs-up flag added to the veto
(to catch slides that just began; the 3d cells sit at 40.1) — −2, Rise worse; H15, flag the top 30% instead
of the top fifth (the veto rarely fires) — 0, Rise worse. Both rejected; 15 of 15 tests used.

**How much crash risk is left to predict?** A pooled crash model (ridge logistic regression on each item's
board percentile of down-vs-up volatility, downside volatility, traded value, price, trend, dip, 14-day and
since-discovery return, kept value, plus each × early membership; trained walk-forward on earlier leagues
only — Jang & Kang 2019; Campbell et al. 2008; Kelly & Jiang 2014) predicts crashes across the whole board
out of sample: AUC 0.57 / 0.73 / 0.76 / 0.67 (Rise / Fate / Runes / Forbidden Rites), early 0.58–0.75, settled
≈ 0.5. As an early-regime veto (H16) it changed nothing but Rise (worse) — because **within Hold's own top 10
its AUC is 0.55 / 0.60 / 0.47**. Hold's ranking already spends the predictable crash risk (its top 10 crash
9% vs the board's 19%); the crashes left inside its picks are not predictable from price and traded value —
the owner's "some crashes are unpredictable" (patches, bugs, new tech, randomness), measured. Retrained on
Hold's own earlier top picks only (H17, the population the veto acts on), the model scores AUC 0.47 within
the top 10 in both leagues it can be tested on (Fate of the Vaal, Runes of Aldur) — no signal at all.

Resumed on the owner's standing instruction ("keep this pattern going"): H18, the dip weight scaled with
the holding period (2× at 14 days) — −1, Fate, Rise and Runes worse; H19, late-regime hold-Divine (a pick
keeps its slot only if kept > 0 and trend > 0, otherwise Divine; Faber 2007, Antonacci) — fires only in
Runes (13 of 69 days), −3, Runes worse: even late, items that lost ground beat Divine often enough.

H20, a veto on items that crashed at the same league phase (±5 days) in earlier leagues — −5, Fate and
Forbidden Rites worse: an item's crash timing doesn't repeat across leagues.

H21, scoring on today alone instead of the 3-day settle (the settle lags a slide) — −3, Fate, Forbidden
Rites and Runes worse: the settle's stability is worth more than its lag.

H22, starting the settled-market veto at early membership < 0.8 (to offset the detector's ~3-day lag) — 0
cells, Rise worse: the veto still hurts while prices are being discovered.

**Crash anatomy (7-day holds).** Fate of the Vaal's 29 crashed top-10 picks come from ~8 items
(Hedgewitch Assandra's Rune of Wisdom 8, Jiquani's Thesis 6), 13 of them in the league's first week; Runes
of Aldur's 62 from a few (Ancient Collarbone 8, Ancient Jawbone 8, Core Destabiliser 6), bunched in weeks 2,
7 and 9. One drop is counted on every day the item sits in the top 10 before it, so the crash cells rest on
roughly a dozen item-level events per league. H23 reacted instead of predicting — an item that fell > 20%
over 7 days in the last 10 leaves the list — −3, Runes worse: fallen items rebound.

**Research round 5 (jump risk).** Single-asset jumps come with unscheduled news (Lee & Mykland 2008 RFS
21(6) [P]: "the majority of jumps occur with unscheduled news"; "jumps do not occur regularly"); jump risk
concentrates in small illiquid assets (Jiang & Yao 2013 [A]) — already in Hold's inputs; jumps cluster and
co-jump across assets (Aït-Sahalia, Cacho-Diaz & Laeven 2015 [P]; Bormetti et al. 2015 [P]; Chen 2024 [A]);
an asset's own skewness/kurtosis barely forecasts its future tails (Boyer, Mitton & Vorkink 2010 [A];
Amaya et al. 2015 [A]); CVaR-optimal selection is unreliable with few observations (Lim, Shanthikumar &
Vahn 2011 [A]). Within Hold's top 10 the jump share of variance scores AUC 0.49 / 0.25 / 0.54 and a decayed
jump intensity 0.57 / 0.25 / 0.46 (Rise / Fate / Runes) — no consistent sign; not built.

A family cojump flag (another item in the same game category fell > 15% over 3 days while this one hasn't
yet) scores AUC 0.52 / 0.51 / 0.49 / 0.49 within Hold's top 10 (Dawn / Rise / Fate / Runes) — no signal.

**Is the crash target even measurable here?** Resampling each league's graded days in 7-day blocks, the
count of crash cells passing ≤ 40 ranges 8–12 (90%; median 10) for the *same* Hold; it reaches 12 in 14% of
resamples. The 9-vs-12 gap sits inside the noise of five leagues — each crash cell rests on about a dozen
item events — so it cannot separate a genuinely safer Hold from luck.

**Where Hold stands:** return percentile ≥ 60 in **17/20** cells (target 16 ✓); crash percentile ≤ 40 in
**9/15** (target 12); list checks 20/20; current league passes. The unmet crash cells are Dawn of the Hunt 14d
(first league, no history, all price discovery), Fate of the Vaal 14d and Runes of Aldur 3d/7d/14d (two sit at
40.1 against the 40 line; the late Runes days are small boards). Likely remaining levers: grade late small
boards on a shorter list; accept that part of the crash rate is exogenous (patches, bugs, new tech).

Crash-prediction sources: Chen, Hong & Stein 2001 JFE 61(3) doi:10.1016/S0304-405X(01)00066-6
https://www.nber.org/papers/w7687 [P] (DUVOL, p.12); Jang & Kang 2019 JFE 132(1) [P] (volatility has the
largest effect on crash odds; turnover not significant); Campbell, Hilscher & Szilagyi 2008 JF 63(6)
https://www.nber.org/papers/w12362 [P] (volatility robust across horizons); Greenwood, Shleifer & You 2019
JFE 131(1) https://www.nber.org/papers/w23191 [P] (run-ups predict crashes in equities — not here);
Hong & Stein 2003 RFS 16(2) [A]; Amihud 2002 [P]; Brunnermeier & Pedersen 2009 [A]; Kelly & Jiang 2014 RFS
27(10) [A]; crypto pump-and-dump studies (Kamps & Kleinberg 2018; La Morgia et al. 2023; Xu & Livshits 2019;
Hamrick et al. 2021; arXiv 2309.06608); CS2 knife trade-up patch crash, Oct 2025 (press). No study predicts
patch-driven crashes from market data — they are exogenous.

## Measurements, 2026-09-28

Walk-forward on the owner's DB, production functions imported, prices in Divine, entry at t+2, the
production eligible universe; five leagues (the forecast needs two prior leagues, so three for it).
Information coefficient (IC) = daily Spearman(signal, forward return); "leagues" = how many agree in sign.

| 7d | days 1–7 | 8–14 | 15–30 | 31–60 |
|---|---|---|---|---|
| production score | .22 [5/5] | .27 [5/5] | .23 [4/4] | .01 |
| retention since league-day 3 | .30 [5/5] | .29 [5/5] | .22 [4/4] | .03 |
| retention since league-day 7 | – | .37 [5/5] | .28 | .08 |
| trend quality (14d slope × R², skip 2) | – | .18 [5/5] | .26 [4/4] | .11 [3/3] |
| spike (3d return − 3 × 14d slope) | −.07 | +.05 | −.07 [0/4] | −.09 [0/3] |
| low realized volatility | −.14 | −.08 | −.20 [0/4] | −.15 [0/3] |
| day-blind forecast | .53 [3/3] | .26 [3/3] | .19 [2/2] | −.05 |

- **Recent risers are not, on average, bad picks through day 30** — the top decile of trailing return
  out-earns the rest in the three recent leagues (the two oldest reverse at 14d). What fails is the
  **jump**: the part of a rise above the item's own trend predicts a fall after day 15 in every league.
- **Retention since league-day 7** (after price discovery) is the best "resists inflation" signal
  through day 30, and cuts the top-10 crash rate (days 8–14: 10% vs production's 16%).
- **Price level is the strongest safety signal**: the most expensive fifth has shallower forward
  drawdowns in all five leagues in days 1–14 (7d crash 20% vs 43% in days 1–7), at a cost in return
  from day 15. Traded value does not predict safety before day 30.
- **Smoothed drawdown** predicts safety better than raw through day 30; raw is better after day 30.
- **Low volatility runs backwards here** (low-vol items underperform in every league) — unlike equities.
- Trend-quality signals are the only ones still positive in every league after day 30 (small, 3 leagues),
  which weakens the 2026-09-20 "nothing survives day 30".
- High-end omens sit at 8–18 div — mid-board by price — so price alone won't put them on top.

Caveats: overlapping windows (report league agreement, not t-stats); five leagues; many signals seen
before picking, so any composite uses fixed equal weights; the replay uses daily closes (production's
hourly exchange-card return has no league-long history).

## Literature, 2026-09-28 (trend quality, spikes, retention, few-sample combining)

Adapted to leagues: rank against the day's cross-section, not an absolute sign (the common drift);
anchor peaks only after discovery; days, not months; leave-one-league-out; volatility is retention risk,
not a return premium.

Legend: **[V-primary]** verbatim from the paper's own PDF · **[V-abstract]** publisher abstract relayed by
search · **[secondary]** another site's description.

| Topic | Source | Link | Used for | Status |
|---|---|---|---|---|
| Smooth vs jumpy gains | Da, Gurun & Warachka (2014), "Frog in the Pan: Continuous Information and Momentum", *RFS* 27(7) 2171–2218 | https://academicweb.nd.edu/~zda/Frog.pdf · doi:10.1093/rfs/hhu003 | information discreteness ID = sgn(PRET)·(%neg − %pos) (eq. 1, p.7), IDZ with zero days (eq. 3, p.9); continuous gains persist and "do not reverse in the long run" | V-primary |
| Trend following | Moskowitz, Ooi & Pedersen (2012), "Time Series Momentum", *JFE* 104(2) 228–250 | doi:10.1016/j.jfineco.2011.11.003 · https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2089463 | own-return persistence with a skip period | V-abstract |
| Trend quality | Clenow (2015), *Stocks on the Move* | https://www.followingthetrend.com/2015/06/stocks-on-the-move-is-out/ · https://teddykoker.com/2019/05/momentum-strategy-from-stocks-on-the-move-in-python/ | exponential-regression slope × R² | secondary |
| Anchor nearness | George & Hwang (2004), "The 52-Week High and Momentum Investing", *JF* 59(5) 2145–2176 | doi:10.1111/j.1540-6261.2004.00695.x | price / recent high; use a post-discovery window in leagues | V-abstract |
| Lottery assets | Bali, Cakici & Whitelaw (2011), "Maxing Out", *JFE* 99(2) 427–446 | https://pages.stern.nyu.edu/~rwhitela/papers/max%20jfe11.pdf | MAX (largest daily return) predicts lower returns in equities | V-abstract |
| Lottery assets, crypto | Ozdamar, Akdeniz & Sensoy (2021), "Lottery-like preferences and the MAX effect in the cryptocurrency market", *Financial Innovation* 7:74 | doi:10.1186/s40854-021-00291-9 | MAX is **positive** in crypto — penalise spikes for retention, not predicted return | V-primary |
| Young markets | Dobrynskaya (2021/2023), "Cryptocurrency Momentum and Reversal", SSRN 3913263 | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=3913263 | momentum up to 2–4 weeks, then reversal, driven by past losers | V-primary (abstract); journal unconfirmed |
| Crypto factors | Liu, Tsyvinski & Wu (2022), "Common Risk Factors in Cryptocurrency", *JF* 77(2) 1133–1177 | doi:10.1111/jofi.13119 | market / size / momentum factors in a young asset class | V-abstract |
| Price discovery | Ritter (1991), "The Long-Run Performance of Initial Public Offerings", *JF* 46(1) 3–27 | doi:10.1111/j.1540-6261.1991.tb03743.x | new listings start high and underperform — skip a league's opening days | V-abstract |
| New listings | CoinGecko / Delphi listing reports | https://beincrypto.com/new-altcoin-listings-price-performance/ | most new listings trade below debut within a year | secondary, not peer-reviewed |
| Low risk | Frazzini & Pedersen (2014), "Betting Against Beta", *JFE* 111(1) 1–25 | https://pages.stern.nyu.edu/~afrazzin/pdf/Betting%20Against%20Beta%20-%20Frazzini%20and%20Pedersen.pdf | the low-risk anomaly; its leverage mechanism is absent in leagues | V-abstract |
| Low risk | Baker, Bradley & Wurgler (2011), "Benchmarks as Limits to Arbitrage", *FAJ* 67(1) 40–54 | doi:10.2469/faj.v67.n1.4 | the low-volatility anomaly; its benchmark mechanism is absent in leagues | V-abstract |
| Drawdown depth × duration | Martin & McCann (1989), Ulcer Index | https://en.wikipedia.org/wiki/Ulcer_index | UI = √mean(squared % drawdown from running peak) | secondary |
| Few-sample combining | DeMiguel, Garlappi & Uppal (2009), "Optimal Versus Naive Diversification", *RFS* 22(5) 1915–1953 | doi:10.1093/rfs/hhm075 | none of 14 optimised models beat 1/N consistently | V-abstract |
| Few-sample combining | Dawes (1979), "The robust beauty of improper linear models in decision making", *Am. Psychologist* 34(7) 571–582 | doi:10.1037/0003-066X.34.7.571 | unit weights are robust | V-abstract |
| PoE2 numeraire | timesaver.gg, PoE2 Divine/Exalted rate, Forbidden Rites | https://timesaver.gg/blog/poe2-divine-exalted-exchange-rate-forbidden-rites-0-5-5 | Exalted deflates as supply grows → price in Divine | secondary |
| Game economies | "Market Interventions in a Large-Scale Virtual Economy" | https://arxiv.org/abs/2210.07970 | candidate, **not read** | — |

No peer-reviewed study ranks in-game items by value retention (searched 2026-09-28). Paywalled primary
texts (SSRN / ScienceDirect returned 403) are marked V-abstract; verify before quoting.

The older sources — momentum vs reversal, return seasonality (Heston & Sadka; Keloharju, Linnainmaa &
Nyberg), overlapping-data inference (Hedegaard & Hodrick), small samples (Gelman 2006), risk-adjusted
composites (OECD/JRC; CFA/Israelsen), shrinkage and ranking (Lin & Louis), uncertainty display, and the
pinned open-source library functions (empyrical, quantstats, ffn, vectorbt, PyPortfolioOpt) — are in
[`research/hold-research-recovered.md` §6](research/hold-research-recovered.md#6-sources), including
§6.13, four places where the old records disagree about what was verified.

## Drawdown cap re-derived (2026-09-29)

The cap's comment said it was the "tightest cap that still spares Mirror/Hinekora": a value picked by
looking at two named items, against the no-hardcoded-bias rule (audit 2026-09-29, A4). Re-derived on the
data alone: `holdscore.MDD_CAP` swept through `ops/hold-backtest.py --league all --workers 1` (the worker
pool re-imports holdscore, so a patched cap only reaches a serial run), graded on the random-list
yardstick only (the `owner` named-item check deliberately left out). 20 cells = 5 leagues × 4 horizons.

| cap | cells ret_pct ≥ 60 | cells crash_pct ≤ 40 | mean ret_pct | mean crash_pct | eligible |
|---|---|---|---|---|---|
| −30% | 14 | 9 | 65.3 | 43.3 | 51 |
| −35% | 13 | 6 | 63.5 | 44.2 | 53 |
| **−40%** | **17** | 9 | **68.2** | 38.1 | 56 |
| −45% | 11 | 8 | 64.7 | 38.9 | 61 |
| −50% | 11 | 9 | 64.6 | 37.8 | 67 |
| −60% | 12 | 9 | 63.9 | 37.3 | 80 |
| −70% | 12 | 14 | 65.1 | 33.2 | 96 |
| −85% | 11 | 17 | 60.9 | 29.5 | 131 |
| none | 5 | 20 | 55.5 | 24.3 | 203 |

No cap wins both: tighter caps buy returns, looser ones avoid crashes. Owner, 2026-09-29: "favor returns"
→ −40% stays, now on its own evidence. Caveat: it is a sharp peak (−35% and −45% score 13 and 11), so it
may be partly noise; re-run this sweep when a new league's data lands. Still open: the gate measures the
drawdown on raw closes from league-day 0 while the Drawdown column shows the smoothed dip since day 7.

## The window is the holding period (2026-09-30)

Owner: "The window is asking 'how long I want to hold this asset for'" … "And the hold should tell you the
best currency to hold for that duration" … "Or do its best good faith attempt" … "the window should
influence the scoring." Bug: [`bugs/2026-09-30-hold-ignores-the-time-window.md`](bugs/2026-09-30-hold-ignores-the-time-window.md).
Before this, `hold_rank` never received the window and 14d was a copy of the 7d board.

**The smoke test changed first.** `ops/hold-backtest.py` now builds each window's own board and holds it
for that window, and grades two new things per league (`window_grade`): `window_same`, the share of
(day, pair of windows) with identical scores (must be 0), and `window_overlap`, the share of the top 10
ranks that carry the same name on the 24h and the 14d board (must be ≤ 0.60). Baseline (the 2026-09-28
ranking): both 1.00 in every league — FAIL.

**What was measured** (DB copy of 2026-09-30 18:00; 5 leagues × 4 windows = 20 cells; every run one at a
time; scratch scorers, repo untouched until the end):

1. *Which signals order the board by its forward H-day return* (daily rank correlation, per league and
   window). Every existing signal works in the same direction at every window; their relative strength
   barely changes. Price is the exception: weakly positive over 1–3 days, negative over 14 (−0.05, 1 of 5
   leagues positive). The cross-league forecast for H days is a coin flip at 1 day and strongest at 14
   (current league +0.06 / +0.03 / +0.13 / +0.34 at 1 / 3 / 7 / 14 days), and with only two earlier
   leagues it misleads (Fate of the Vaal −0.10 … −0.20).
2. *The chance band.* Ten runs with a random per-item signal added (weight 0.25): 18–27 cells clearly
   worse (> 1 point), 3–9 better; mean return percentile 68.4 → 65.3–66.7. So a window-dependence that
   isn't real costs about two points.
3. *About 90 candidates*, each graded on all 20 cells against the 2026-09-28 ranking (better / worse =
   cells moving by more than 1 percentile point):

| idea | result |
|---|---|
| the record reads H-day holds (keep 0.8^(H/14)), or H-day holds that kept ≥ 0 | 2 / 9, 7 / 16 — worse at short windows |
| kept = the median or the mean/sd of this league's H-day holds | 4 / 9, 5 / 12 |
| dip = this league's worst H-day hold | 5 / 8 — helps 14d, hurts 7d |
| trend over max(5, 2H) days | 3 / 4 — the short lookbacks hurt 24h and 3d |
| safety-first score (μH + d) / (σ√H) (Roy 1952) in place of steadiness, added, or in place of kept | 3 / 6, 6 / 12, 5 / 17 |
| liquidity (traded value) weighing more for short holds | 3 / 12; −11 points of return at 3d–14d (liquid items return less) |
| short-term reversal (−1-day return) for short holds, after discovery | 2 / 2 — no clear effect |
| veto strength scaled to the hold (VETO_MAX × √(H/7)) | 1 / 1 |
| weights of climb / safety / price groups × {0.67, 1, 1.5}, per window (26 runs) | 24h: more price +1.8 (3 leagues up, 0 down); 3d, 7d, 14d: the tuned weights are the best of the grid |
| each signal dropped or doubled, per window (30 runs) | price wants more weight at 24h and less by 14d; climb the reverse; trading activity ×2 helps a little everywhere |
| price × (7/H)^a and climb × (H/7)^a, a ∈ {0.25, 0.5, 0.75} | 24h gains, 14d loses (Rise of the Abyssal −6.6 crash) |
| **price × (1 + 0.6/H²)** | 24h better in 4 of 5 leagues, nothing else moves |
| **trend over max(14, 2H) days** | 1 / 0 (Runes of Aldur 14d +1.4) |
| forecast for H days as a signal, ≥ 2 earlier leagues | 3 / 10 — Fate and Runes worse at every window |
| **forecast for H days, ≥ 3 earlier leagues, weight 0.25** | 7 / 2 |
| the same at weight 0.5 / 1.0 | 6 / 5; 4 / 7 and the current league misses crash ratio at 24h |
| **forecast weight 0.25 × H/7** | 6 / 1 |

**Finding.** What makes an item hold its value is mostly the same from a day to a fortnight: expected
return is drift, and drift persists. Three things do depend on the holding period, and only those went in.

**The ranking** (`holdscore.hold_rank(..., hold=days)`; constants `PRICE_SHORT`, `FORECAST_W`,
`FORECAST_MIN_LEAGUES`; tests `backend/tests/test_hold_window.py`):

| term | rule | why |
|---|---|---|
| price | weight × (1 + 0.6 / H²) | over a day the price level protects and the climb hasn't time to pay; from 3 days on it is the tuned weight |
| forecast | what the item did over the next H days from this league-day in earlier leagues (`_predict`, ±5 days, ≥ 3 leagues), weight 0.25 × H / 7 | a league-phase pattern needs time to play out; the arrows were already known to be a coin flip at 1 day |
| trend | read over max(14, 2H) days | a two-week hold is judged on a month of climb |

14d is a real window: `HORIZON_DAYS["14d"] = 14`, `MAX_HORIZON_DAYS` is gone.

**Result** (2026-09-28 ranking → this one; `ret_pct` higher is better, `crash_pct` lower is better):

| league | window | return percentile | crash percentile | vs board | same name at the same rank, 24h vs 14d |
|---|---|---|---|---|---|
| Dawn of the Hunt | 24h | 59.4 → 63.2 | 49.4 → 49.6 | +3.5 → +3.9 | 0.39 |
|  | 3d | 62.4 → 62.7 | 37.9 → 38.0 | +14.3 → +14.3 |  |
|  | 7d | 67.1 → 67.2 | 38.3 → 38.3 | +22.6 → +22.6 |  |
|  | 14d | 61.3 → 61.4 | 59.3 → 59.2 | +30.3 → +30.3 |  |
| Rise of the Abyssal | 24h | 68.3 → 70.5 | 44.8 → 43.5 | +2.4 → +2.7 | 0.38 |
|  | 3d | 75.8 → 75.7 | 31.1 → 31.2 | +8.1 → +8.0 |  |
|  | 7d | 80.9 → 80.9 | 29.0 → 29.0 | +15.6 → +15.6 |  |
|  | 14d | 80.2 → 79.9 | 20.8 → 20.7 | +26.7 → +26.4 |  |
| Fate of the Vaal | 24h | 62.6 → 64.5 | 47.8 → 47.1 | +1.8 → +1.8 | 0.47 |
|  | 3d | 66.4 → 66.6 | 40.1 → 39.6 | +5.8 → +5.8 |  |
|  | 7d | 64.3 → 64.3 | 37.0 → 37.0 | +11.1 → +11.1 |  |
|  | 14d | 48.4 → 48.6 | 41.8 → 42.6 | +21.5 → +21.2 |  |
| Runes of Aldur | 24h | 59.1 → 58.8 | 44.9 → 45.7 | +1.5 → +1.3 | 0.31 |
|  | 3d | 60.3 → 61.4 | 40.1 → 40.3 | +4.3 → +4.3 |  |
|  | 7d | 60.6 → 60.6 | 45.3 → 43.7 | +6.4 → +6.8 |  |
|  | 14d | 60.8 → 67.6 | 47.2 → 40.0 | +9.3 → +12.4 |  |
| Forbidden Rites (current) | 24h | 72.6 → 73.2 | 43.1 → 43.0 | +3.0 → +2.8 | 0.27 |
|  | 3d | 79.4 → 82.7 | 27.9 → 27.9 | +8.1 → +8.5 |  |
|  | 7d | 88.7 → 91.1 | 19.9 → 23.0 | +20.3 → +22.7 |  |
|  | 14d | 89.3 → 91.3 | 13.5 → 13.7 | +45.2 → +46.6 |  |

- 11 cells better by more than a point, **1 worse**: Forbidden Rites 7d crash percentile 19.9 → 23.0. That
  is one pick on one day (league-day 12: 1 of 10 lost more than 20%; 1 of 140 picks over the league); the
  same window's return percentile rose 2.4 and its crash ratio is 0.08 against a limit of 0.50. Not tuned away.
- Return percentile ≥ 60 in 18 of 20 cells (was 17), crash percentile ≤ 40 in 11 of 20 (was 9); means
  68.4 → 69.6 and 38.0 → 37.7.
- Current league: every threshold passes at 24h, 3d, 7d and 14d; `window_same` 0.00; `window_overlap` 0.27.
- `window_same` is 0.00 in every league and `window_overlap` 0.27–0.47.

**Limits, stated plainly.**
- The lists overlap a lot: on the current league the 24h and 14d top 10 share about 8 names, and the first
  few places are usually the same, because the same items are the best holds over any of these periods.
  Forcing more difference costs returns (the chance band, and forecast weights 0.5 / 1.0 above).
- The forecast has three or more earlier leagues behind it in only two leagues (Runes of Aldur, Forbidden
  Rites), so its evidence is two leagues, both positive. Re-run `--league all` when the next league lands.
- In a league with fewer than three earlier leagues the windows differ only by the price and trend terms.
- The window check's first definition (median count of shared names) read 0.8–1.0 for every candidate and
  couldn't tell them apart; it now counts names at the same rank, which a player reading the list top down
  actually sees.
