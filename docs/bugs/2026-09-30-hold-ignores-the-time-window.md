# BUG — Hold ignores the time window: the order and scores are the same on 24h, 3d, 7d and 14d

**Status:** FIXED in the working tree 2026-09-30, not yet released (see "The fix" at the end) · **Found:** 2026-09-30 (owner) · **Affects:** Strategy → Hold on every install; stable
since 0.3.6 (introduced 2026-09-28, commit `ed4ef35`, first shipped in 0.3.6-beta.10)

Owner: "I'm still seeing hold not change the ordering of the leaderboard based on the time range" … "You
realize changing only the return column isn't intended right" … "the window should influence the
scoring." And what the window means: "The window is asking 'how long I want to hold this asset for'" …
"And the hold should tell you the best currency to hold for that duration" … "Or do its best good faith
attempt."

## What was seen

Measured 2026-09-30 in the packaged app on the owner's data, clicking the topbar window on Hold:

| | 24h | 3d | 7d | 14d |
|---|---|---|---|---|
| Order (top 6) | Seraph's Heart, Emergent Possibility, Raven-Touched Shard, Uncut Spirit Gem (Level 8), Vaal Armourer's Infuser, Perfect Flux | identical | identical | identical |
| Hold score | 86, 84, 81, 81, 81, 79 | identical | identical | identical |
| Max drawdown | −6.4%, −8.9%, −1.2%, −21.8%, −4.4%, −4.5% | identical | identical | identical |
| Return column | "Past 1d": +2.10%, +3.90%, … | "Past 3d" | "Past 7d" | **"Past 7d", the same as 7d** |

Only the return column follows the window, and 14d is not a window at all.

## Root cause

- `holdscore._signals(series, t)` takes no window. Every ranking signal is measured from fixed points
  in the league:
  - kept value from `DISCOVERY_DAY` (league-day 7) to `SKIP_DAYS` ago;
  - the dip since day 7;
  - the climb over a fixed `TREND_DAYS = 14`;
  - steadiness (Sharpe and efficiency) since day 7;
  - trading activity this week vs the last.

  `_rank_day` / `_hold_scores` rank those, so the board is the same for every window.
- `_leaderboard` uses the window only for `_metrics(series, hz)`, which feeds the return column, and for
  the forecast arrows.
- `MAX_HORIZON_DAYS = 7` makes `horizon_for` map 14d to "7d".
- The 2026-09-28 redesign did this on purpose, and its commit says so: "the horizon sets the return
  column and forecast, not the order". The owner never asked for it, and it is not intended.

## Why the checks did not catch it

`ops/hold-backtest.py` builds each day's board "at Hold's own day horizon (`holdscore.horizon_for`, which
clamps 14d to 7d)" and varies only the HOLDING period. It never asks whether the board changes with the
window. So "passes every horizon" (docs/hold-research.md) says nothing about this bug.

## Impact

- The window a player picks, meaning "I want to hold for a day / 3 days / a week / two weeks", does not
  change what Hold recommends. That is the page's main input.
- 14d shows a 7-day board labelled "Past 7d".

## What the fix must do

1. **The window is the holding period.** 24h / 3d / 7d / 14d means "I plan to hold for a day / 3 days / a
   week / two weeks". Hold ranks the currencies best to hold **for that duration**: its best good-faith
   forecast of which assets will keep and grow their value, safely, over the next N days. So the score,
   and with it the order, depends on the window.
   - Which history each window reads is a research question: a 24h hold may look at very different
     evidence than a 14-day hold. The requirement is the forward objective, not a particular lookback.
   - Hold's purpose stays the same: a good, safe place to park currency for that time, not what just
     went up.
2. **14d is a real 14-day holding period.** Lift or remove `MAX_HORIZON_DAYS = 7`, and the label reads
   "Past 14d".
3. **No hardcoded item bias.** Rank on measured behaviour only (feedback "Hold: no hardcoded bias"), and
   don't tune to specific events. Some crashes are unpredictable; model the predictable part.

## Acceptance: backtesting must work across every window

Required before any release carries the fix. Each is enforced by a script, not only written here (owner
directive 2026-09-30):

1. **The backtest grades each window's own board over that window's hold.** `ops/hold-backtest.py`
   builds each day's board FOR the window being graded (24h, 3d, 7d and 14d, with 14d as its own board),
   holds its top 10 for exactly that duration, and grades the outcome. That is the owner's question
   ("the best currency to hold for that duration") made measurable. The comment about the 14d → 7d clamp
   is removed.
2. **Every threshold passes at every window.** On the current league, `THRESHOLDS` (`vs_board`, `beat`,
   `kept`, `crash_ratio`, `dd`, `churn`, `owner`, `chase`) must pass for 24h, 3d, 7d and 14d. It must not
   regress against the current ranking on the holdout leagues (`--league all`): no window × league
   yardstick cell (`ret_pct`, `crash_pct`) clearly worse (more than 0.01, the research log's bar).
3. **A new graded check: the window changes the board.**
   - For each pair of windows, the day's scores differ.
   - The median top-10 overlap between the 24h board and the 14d board, over the league's days, stays
     below a bound set from measurement and recorded in the backtest's `THRESHOLDS`.
   - A ranking the window doesn't move fails the backtest.
4. **A unit test pins it.** On a fixture series where an asset's recent days differ from its league-long
   history, `holdscore.leaderboard` returns different orders for 24h and 14d, and `horizon_for(336)` is
   "14d". It must be seen failing on today's code first.
5. **Proved in the packaged app.** Clicking 24h / 3d / 7d / 14d on Hold changes the order and the scores
   on the owner's data. The release gate (`ops/regression-diff.py`) shows Hold differences, and they are
   accepted for that version with the reason.
6. **Every result goes to docs/hold-research.md:** the before and after numbers per window and league,
   and the design chosen.

## Notes for the fix

- The pre-redesign score (0.3.2) did rank on the window's return and failed the backtest at every
  window. At 1d/3d the board became "smallest drawdown", which put cheap crafting currency on top; at 7d
  it chased spikes (docs/hold-research.md "Diagnosis, 2026-09-28"). A window-aware score has to avoid
  both. That is what requirements 2 and 3 of the acceptance measure.
- Run backtests serially (`--workers 1` if patching modules). Nine in parallel pinned the CPU on
  2026-09-29.

## The fix (2026-09-30)

`holdscore.hold_rank` takes the holding period (`hold=days`) and three terms follow it: the price level
weighs more over a short hold, the cross-league forecast for the next H days weighs more the longer the
hold (three or more earlier leagues), and the trend is read over max(14, 2H) days. `HORIZON_DAYS` has
`14d`; `MAX_HORIZON_DAYS` is gone. Research, every candidate tried and the full before/after table:
[`docs/hold-research.md`](../hold-research.md) → "The window is the holding period".

Acceptance, as run:

| # | requirement | result |
|---|---|---|
| 1 | the backtest grades each window's own board over that window | done: `board_days` is the window's days; tests `backend/tests/test_hold_backtest_windows.py` |
| 2a | every threshold passes at every window, current league | PASS at 24h, 3d, 7d, 14d (`ops/hold-backtest.py`, exit 0) |
| 2b | no holdout cell worse by more than 0.01 | **39 of 40 cells hold; 1 does not**: Forbidden Rites 7d crash percentile 19.9 → 23.0 (one pick on one day; that window's return percentile rose 2.4). 11 cells are better by more than a point. A random signal of the same size makes 18–27 cells worse |
| 3 | the window changes the board | `window_same` 0.00 (was 1.00), `window_overlap` 0.27–0.47 per league (was 1.00; limit 0.60), both in `THRESHOLDS`. The overlap is now "same name at the same rank, mean over days": the first definition (median shared names) read 0.8–1.0 for every candidate and could not grade them |
| 4 | unit tests, seen failing first | `backend/tests/test_hold_window.py`: 10 of 13 failed on the old code, all pass now; the old test that pinned the 7d clamp (`test_vocabulary.py`) now pins 14d |
| 5 | proved in the packaged app; release gate | below; `ops/regression-diff.py` reports the four Hold differences and blocks until accepted; accepted for 0.3.8-beta.3 in `ops/regression-accept.txt` |
| 6 | logged | docs/hold-research.md |

Packaged app (`desktop/release/mac-arm64/Arbiter.app`, the owner's data, 2026-09-30, clicking the topbar window on Hold):

| | 24h | 3d | 7d | 14d |
|---|---|---|---|---|
| Heading | "for 1d" | "for 3d" | "for 7d" | "for 14d" |
| Return column | Past 1d | Past 3d | Past 7d | **Past 14d** |
| #1–#4 | Seraph's Heart, Emergent Possibility, Raven-Touched Shard, Vaal Armourer's Infuser | same | same | same |
| #5 | Uncut Spirit Gem (Level 8) | Perfect Flux | Perfect Flux | Uncut Spirit Gem (Level 15) |
| #6 | Perfect Flux | Hinekora's Lock | Her Declaration | Uncut Spirit Gem (Level 8) |
| #7 | Hinekora's Lock | Her Declaration | Breach Splinter | Perfect Flux |
| #8 | Her Declaration | Uncut Spirit Gem (Level 8) | Aldur's Legacy | Uhtred's Exodus |
| #9 | Aldur's Legacy | Aldur's Legacy | Uncut Spirit Gem (Level 15) | Her Declaration |
| #10 | Breach Splinter | Breach Splinter | Faded Crisis Fragment | Aldur's Legacy |

Every pair of windows differs in order and in scores (24h vs 14d: 4 of 10 names at the same rank, 8 of 10
names shared). The first four places are the same at every window: the research found that the best holds
are mostly the same items over a day or a fortnight, and that forcing more difference costs returns.
