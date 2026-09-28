# Hold: the recovered research (2026-09-13 → 2026-09-28)

Recovered 2026-09-28 from Claude Code session transcripts. The files these came from are gone, but their
contents survive in the JSONL transcripts as Write/Edit tool calls and subagent hand-backs. Where a document
is quoted, it is quoted verbatim from the transcript. Everything in the appendices is verbatim. Timestamps are
UTC, taken from the transcript records.

## 0. Where everything came from

| What | Original path (gone) | Recovered from | When (UTC) |
|---|---|---|---|
| Hold design research: "Quant hold-scoring methodology + OSS" | agent report | `~/.claude/projects/-Users-ianmoreno/15b714b2-6a76-417b-b058-e0f414280444/subagents/agent-a7aac8a574734f238.jsonl` | 2026-09-13 21:28 |
| Hold design research: "PoE2 asset classes + hold wisdom" | agent report | `…/15b714b2…/subagents/agent-a14d57f3d48e9a082.jsonl` | 2026-09-13 21:28 |
| The /simplify pass that cut the weighted-z score | agent report | `…/15b714b2…/subagents/agent-aeb9317211654c674.jsonl` | 2026-09-13 21:36 |
| `scratchpad/research-grounding.md` | `/private/tmp/claude-501/-Users-ianmoreno/15b714b2-…/scratchpad/research-grounding.md` | Write call in `…/-Users-ianmoreno/15b714b2-6a76-417b-b058-e0f414280444.jsonl` | 2026-09-15 00:49 |
| `scratchpad/research-synthesis.md` (final, after 2 edits) | `…/15b714b2-…/scratchpad/research-synthesis.md` | Write + 2 Edit calls, same file | 2026-09-15 01:01–01:03 |
| `scratchpad/arena-decisions.md` (final, after 1 edit) | `…/15b714b2-…/scratchpad/arena-decisions.md` | Write + Edit, same file | 2026-09-15 01:32–01:39 |
| `scratchpad/arena-strategy/SYNTHESIS.md` | `…/15b714b2-…/scratchpad/arena-strategy/SYNTHESIS.md` | Write call, same file | 2026-09-15 01:45 |
| Strategy-tab research lanes A (quant OSS) and D (signals) | agent reports | `…/15b714b2…/subagents/agent-a7a55fef74f6e363d.jsonl`, `agent-a6bdf8384eec49818.jsonl` | 2026-09-15 00:50 |
| Six literature reports on the Hold bug (2026-09-20) | agent hand-backs | `~/.claude/projects/-Users-ianmoreno-shazam-poe2-dashboard/bc10d31b-…/subagents/agent-{a5945db6449688ae9, afc2dd32951b79114, a10ba31604e2e3925, aca34b45ac6b7055b, a008b46e559c2e7a7}.jsonl` | 2026-09-20 19:52–20:01 |
| Two literature reports on the forecast window (2026-09-21) | agent hand-backs | `…/bc10d31b…/subagents/agent-{a0a7f1ae788cef42e, a6188b5507f344f08}.jsonl` | 2026-09-21 01:18 |
| Experiment scripts `harness.py`, `exp0`–`exp13` and their outputs | `/private/tmp/claude-501/-Users-ianmoreno-shazam-poe2-dashboard/bc10d31b-…/scratchpad/` | Bash heredocs + tool results in `…/bc10d31b-0afd-4748-b7f2-d41c5ac8a018.jsonl` | 2026-09-20 20:48–21:09 |
| `ic_harness.py`, `adversarial.py`, `decisive.py`, `window.py`, `lagcurve.py`, `band.py`, `bench.py` and outputs | same scratchpad | same transcript | 2026-09-21 00:53–01:25 |

**Already in the repo (not gone, and the best curated record of the 2026-09-20 work):**
`docs/bugs/2026-09-20-hold-ranks-against-its-own-forecast.md` (diagnosis, backtest, the 0.3.2 fix) and
`docs/bugs/2026-09-20-hold-open-items-handoff.md` (the 0.3.3 forecast window/arrows, open items, and a
verified-vs-unverified source list). This file does not repeat them in full; it adds what they leave out.

**Not recovered:** the extracted paper PDFs/text (`heston_sadka.pdf`, `nber20815.pdf`, `seasrev.pdf`, `tw.pdf`,
`lt70b2.txt`, `agkrou.txt`, `2jhpue.txt`, `jewett.txt`, `oecd.txt`, `empyrical_stats.py`,
`quantstats_stats.py`, `ffn_core.py`, `vbt_nb.py`, `ppo_risk.py`). Those were downloaded by agents and never
passed through a tool call's text. Their URLs and pinned commits are in §6, so they can be fetched again. The
arena-strategy candidate plans (4 × ~25 KB) were recovered but are about the Strategy tab as a whole
(Convert, Ghost Wealth, sidecar), not Hold scoring, so they are left out here. The 2026-09-13 research did
not produce a SYNTHESIS for Hold: the Hold design lived in the three 2026-09-13 agent reports plus the
commit message of `b11d32b`. The `arena-strategy/SYNTHESIS.md` that the 2026-09-20 bug doc calls "the
Hold design" is in fact the 2026-09-15 Strategy-tab expansion synthesis. It mentions Hold only in passing.

---

## 1. What matters for redesigning how Hold ranks

The owner's 2026-09-28 complaint: Hold *"is weighting items that have gone up recently, not the items
that resist inflation the most and are on the upswing and prepared to go up in value or retain value."*

1. **The owner's intent has not changed since 2026-09-14.** *"The idea is to have items rated to beat
   inflation over time. An asset that is good to park your currency in. Typical examples are Hinekora's
   Locks, Mirrors, Omens of Whittling, Omens of Dextral Annulment"* (15b714b2, 2026-09-14 07:29). On
   2026-09-15 01:00: *"hold is retaining wealth -> directly related to combating inflation."* On
   2026-09-20 20:59: *"mirrors and locks are almost always safe places to park money even if they're not as
   liquid … akin to a house or gold."*
2. **The horizon drifted away from that intent.** The original design (2026-09-13) ranked on 7d, 30d and
   whole-league return, and the research weighted the long horizon most (`0.25·7d + 0.35·30d + 0.40·league`)
   *because* "a store of value should hold across timeframes". The /simplify pass kept 30d and whole-league
   and dropped 7d as "noisy … 'what to hold' is inherently not a day-trade question". Then `f366684`
   (2026-09-14) replaced 7d/30d/whole-league with **1d/3d/7d** because "leagues move fast". Today
   `_metrics` still ranks on `last/base − 1` over 1/3/7 days (`MAX_HORIZON_DAYS = 7`). That is exactly
   "recently gone up". The drawdown term reads the whole league, but return does not.
3. **The literature on that horizon:** Jegadeesh & Titman (1993) place continuation at 3–12 months and skip
   the most recent week. At 1 week to 1 month the equity finding is *reversal*, and it is strongest in thin,
   high-turnover assets (Avramov/Chordia/Goyal 2006; Zaremba 2021 for daily crypto). **But our own data
   overruled this**: with the measurement trap removed (gap ≥ 2 days), trailing 3d return has IC ≈ +0.01
   to +0.03, and the whole score has IC +0.21 to +0.28 in league days 1–14, dying to ≈0 after day 30. So a
   short-horizon return is not anti-predictive here. It is simply not what the owner asked Hold to measure.
4. **"Steady upswing" has a ready-made, verified metric: empyrical's `stability_of_timeseries`.** It is the
   R² of an OLS fit to cumulative log returns (verified at empyrical `40f61b4`, stats.py L1471–1498). The
   variable name `stab` was almost certainly borrowed from it, but the code used `1 + mdd` instead. Caveat,
   verified: *"A straight line down scores R² ≈ 1.0"*, so it must be paired with the sign or slope of the
   fit (for example slope × R², or R² gated on a positive slope). It is a straightness diagnostic, never a
   score on its own.
5. **Drawdown depth and duration: Ulcer Index / Martin ratio.** Ulcer Index is the RMS of drawdowns. It
   *"penalises both depth and duration — strictly richer than your single `mdd`"* (report aca34, citing
   luxalgo; Martin & McCann 1989). quantstats `ulcer_index` / `ulcer_performance_index` (verified at
   `fbd10da`) put it in the denominator.
6. **Any composite must be sign-safe.** Proven in 0.3.2: multiplying a signed return by factors in [0,1]
   inverts below zero. The licensed forms are:
   - a subtraction on the return's own scale (Morningstar MRAR);
   - a sum of logs of strictly positive wealth factors: `log(1+ret) + k·log(1+mdd)` is what shipped, and the
     OECD/JRC Handbook licenses geometric aggregation *"provided that x is strictly positive"*;
   - a ratio with a non-negative denominator (Calmar, Martin, Serenity).

   The original rejected design, a robust-z *sum* (`0.40·z(R) + 0.25·z(Calmar) − 0.20·z(|MDD|) +
   0.15·z(Sortino)`), was sign-safe. The /simplify pass replaced it with the sign-unsafe product.
7. **"Resists inflation" needs a hard numeraire, and PoE has a known inflation arc.** The research: *"Never
   score in Exalted"*. Divine is the default numeraire, with Mirror/Hinekora's Lock as the hard anchors the
   owner named (2026-09-13 19:01). Across a league, Divine rises in Exalted terms (≈100–130 → ≈390–430
   Ex/Div). Most items decay after week 1. Omens, Ancient/Potent Liquid Emotions, Greater/Perfect essences,
   Refined catalysts and L20 uncut gems are the "late-league appreciators". Splinters, base essences, base
   catalysts and low runes are "early-dump commodities". Chaos deflates against Divine by design, and the
   −40% cap cuts it at every level.
8. **What already failed and must not come back:**
   - an absolute liquidity floor (30M ex/day was reached by 0% of assets in the first 30 days; the scale
     shifts 14× between leagues);
   - `liq` as a multiplier (it selects *big*, not *steady*);
   - k > 3 (safety saturates at a −14.0% top-10 drawdown);
   - drawdown caps tighter than −40% (they cut Mirror and Hinekora on 25–35% of early days);
   - tuning a blend weight on 3–4 leagues (Gelman 2006: pooling parameters are unidentifiable below J≈5);
   - raising `MIN_PRED_LEAGUES` on skill grounds (confounded).
9. **The forecast is the better early-league signal and it is still not in the ranking.** Opening-fortnight
   7d IC, leave-one-league-out: forecast +0.29/+0.36/+0.33 against score +0.15/+0.17/+0.27. The two are
   near-orthogonal (corr +0.03 to +0.09). A fixed 50/50 rank blend measured +0.525 against +0.322 (7d, days
   4–7). The literature says to integrate before ranking (AQR 2016: *"avoiding stocks with offsetting style
   exposures"*), with fixed, untuned weights (forecast-combination puzzle). No signal of any kind survives
   league-day 30. Past that point the honest board is "what has held value" (drawdown/steadiness), not a
   forecast.

---

## 2. What the owner said about Hold (verbatim, chronological)

Session `15b714b2` = `~/.claude/projects/-Users-ianmoreno/15b714b2-6a76-417b-b058-e0f414280444.jsonl`;
`bc10d31b` and `7a5f6d51` = `~/.claude/projects/-Users-ianmoreno-shazam-poe2-dashboard/<id>.jsonl`.
"(queued)" = typed while the agent was busy, stored as a `queued_command` attachment.

- **15b714b2 2026-09-13 19:01** — "You have to make sure the currencies are compared to Mirrors and Hinekora's Locks because those are the more high tier assets in PoE and more accurately track inflation. It would be interesting to create a historical view using older leagues and tracking the age of the current league against the inflation of previous leagues at the same time period. Investigate open source financial analysis tools to apply to these metrics."
- **15b714b2 2026-09-13 21:27** (the goal that created Hold) — "The Primary objective to the inflation data is to yes show us inflation data, but its primary purpose is to show what assets are good to hold over the short, medium, and long term against other assets. Do research on what open source projects could help us determine this and have a leaderboard of different assets in POE that retain or increase in value over the course of a league with a predictive aspect based on the historical data from previous leagues. Make sure to include obscure currencies like a lot of what poe2scout exposes. Omens tend to be particularly attractive a lot of the time for example. Investiage and do deep research on this topic and feature, then come up with a plan of how to display this information, then run a /simplify pass on the plan, then build it."
- **15b714b2 2026-09-13 21:58** — "I do want the leaderboared on the desktop app, I just think iteration should be methodical on the web version"
- **15b714b2 2026-09-14 07:04** — "I think the time horizons of the defaults are too high, leagues in poe move fast so we need to make the default time horizons like 1h, 6h, 12h, 1d, 3d, 7d." *(this led to `f366684`: Hold went from 7d/30d/whole-league to 1d/3d/7d)*
- **15b714b2 2026-09-14 07:21** — "The hold page is also just showing like disingenuious values. Like I know for a fact essences are actually going down in value not up so they are a bad investment. We need to dig into why. I think there is some sort of bug. Because I would expect things like omens of whittling to be at the top, things tat have accrued in value."
- **15b714b2 2026-09-14 07:29 (queued)** — "The idea is to have items rated to beat inflation over time. An asset that is good to park your currency in. Typical examples are Hinekora's Locks, Mirrors, Omens of Whittling, Omens of Dextral Annulment"
- **15b714b2 2026-09-14 23:40** — "I want to improve the 'at a glance' view by adding the top 3 investments from the hold leaderboard from left to right."
- **15b714b2 2026-09-15 00:03** — "The values in the hold view aren't nesseciarly the biggest movers, the biggest movers are the items that have the most % change over the time period specified in the view."
- **15b714b2 2026-09-15 01:00 (queued)** — "These agents need to really come up with ideas that are meaningfully solving a problem. The arbitrage one is market making -> directly related to generating revenue, hold is retaining wealth -> directly related to combating inflation"
- **15b714b2 2026-09-15 01:08** — "…A good place to start is look for open source things akin to the tools we're already using, the inflation tools, what is hold using, what tools is arbitrage using? … I think you went too far into financial markets in your exploration, that was a good exercise but not exactly what we're looking for. Are there other interesting computer science algorithms that fit the shape of our data?"
- **15b714b2 2026-09-15 06:08 (queued)** — "…on the Hold page I'd like to have the ability to select the hold view or the positive mover view to see all of the top movers leaderboard. I only want to see the positive swings on that leaderboard but make it secondary to the actual hold leaderboard as I think its better."
- **bc10d31b 2026-09-19 14:40** — "Why are we using daily data for hourly views? If we have the hourly data then shouldn't we be using that for Hold/Movers…"
- **bc10d31b 2026-09-19 15:07 (queued)** — "The hold calculations also seem to be just wrong, their projected prices are saying they will fall in some cases."
- **bc10d31b 2026-09-20 19:43** — "…I want you to investigate the HOLD page. Its displaying some currencies that we're actually predicting will go down in value. I want to understand WHY. Don't make changes, this is an investigation … your best guide is the production data … if you do deploy sub agents to investigate you must validate all of their claims … when we do start making changes you must follow /tdd for ALL changes."
- **bc10d31b 2026-09-20 19:52** — "…look at how we're doing all these calculations and research them online … I want to know the internet's consensus on how to fix this, and I want different ideas and different opinions so fan out research agents … always validate their claims against their sources."
- **bc10d31b 2026-09-20 19:55 / 19:56 / 20:00** — "There are libraries we sourced this code from, its just not directly referenced." / "Look at the design docs from the initial implementations." / "I know the inspiration for hold came from online reasearch of opensource finance libraries"
- **bc10d31b 2026-09-20 20:47** — "I mean in some cases it makes sense and predicts things that should go up over time. But in other cases it suggests rediculous things. I think what you need to do is run a bunch of test experiments on how we should be filtering and what the data looks like if you alter things (without altering production code) to see whats going on"
- **bc10d31b 2026-09-20 20:59** — "Figure out where to write the volume floor but the thing is, mirrors and locks are almost always safe places to park money even if they're not as liquid as other currencies. They're relatively stable assets akin to a house or gold. They just can't be traded too much because they're extreamly rare."
- **bc10d31b 2026-09-20 21:04 / 21:07 / 21:24** — "What does k=3 give us?" / "yes, test where the drawdown cap should sit" / "Okay we need to give K a name in the UI that is descriptive in what it does in one word and label the slider as that" *(became "Caution")*
- **bc10d31b 2026-09-20 23:52** — "Hold definitly looks better ship it" *(0.3.2)*
- **bc10d31b 2026-09-21 00:57** — "Double check your work, validate your assumptions, and never guess. I want you to adversarilly challenge your assumptions. The doc was made with a lot of effort and trial and errors including tests."
- **bc10d31b 2026-09-21 01:05** — "The way we're doing the new predicionts is the industry standard way of evaluating and cutting out noise. If we actually just did the naive average that would undo what all the previous commits were intended to do"
- **bc10d31b 2026-09-21 01:14** — "So what should we change about hold. Be brief, 1 sentence max" / "What about the time range picker? Shouldn't that be widening the prediction read?"
- **bc10d31b 2026-09-21 01:17** — "Are we building this change the correct way? Do some research online about the exact change we're trying to make. This screen is based off a paper we found/some financial research. Do some digging"
- **bc10d31b 2026-09-21 02:11** — "…follow /tdd to the letter … KISS … do not drift from the exact course we have plotted … Tests involving production data is even better because it rigerously tests our assumptions against realit…"
- **bc10d31b 2026-09-21 02:29** — "…since we cannot effectively show what an exact percentage would be lets use symbols instead. Like green up arrows and it can go from 1 arrow to three and they can either be up or down and they should be red if pointing down."
- **bc10d31b 2026-09-21 02:55–02:56** — "If the arrows are no better than a coinflip on 1d then we should just hide the column on 1d" / "yes go with dashes on 1d"
- **bc10d31b 2026-09-25 06:18** (README brief) — "…can tell you which currencies are going to be resistant to inflation and are good assets to park wealth in…" and "Its your one stop shop for trading, market research, and protecting your stash against inflation."
- **7a5f6d51 2026-09-28 18:51** — "Hold is a bug that we need to focus on, right now its weighting items that have gone up recently, not the items that resist inflation the most and are on the upswing and prepared to go up in value or retain value, its too heavily weighting items that have recently gone up in value"
- **7a5f6d51 2026-09-28 18:52 (queued)** — "do a deep research on hold and how it works then run /arena on ways to fix it"
- **7a5f6d51 2026-09-28 18:53** — "There are a lot of documents and academic papers around how hold works, you need to make sure to read those"

---

## 3. How the score evolved, and what was considered and rejected

| When | Commit | Score | Why |
|---|---|---|---|
| 2026-09-13 21:28 | (research) | Per horizon: `0.40·z(R) + 0.25·z(Calmar) − 0.20·z(\|MDD\|) + 0.15·z(Sortino)` with robust z (median/MAD); horizons blended `0.25·7d + 0.35·30d + 0.40·league`; × `confidence = λ·coverage·liquidity`, `λ=n/(n+k)`, k≈10–20; hard liquidity gate. Predictor: `Σ γ^age·f_L`, γ≈0.6–0.7, rank by `Pred·ConfPred`, `ConfPred = 1/(1+Disp)·n/(n+2)`; optional `β·Pred + (1−β)·EWMA·Δ`, β≈0.6. | Agent a7aac, **answered "from domain knowledge", no web research**. Weights hand-picked. |
| 2026-09-13 21:36 | (simplify) | **Rejected** the weighted-z: "unexplainable … Nobody can validate those weights on 5 leagues of data." Proposed `HOLD_v1 = return-in-Divine × confidence`, drawdown as a separate column; horizons 30d + whole-league (drop 7d as "noisy"); defer Calmar/Sortino/Sharpe, EWMA blend, 7d. | Agent aeb93. The reason the sign-safe sum became a sign-unsafe product. |
| 2026-09-13 21:52 | `b11d32b` | `hold = ret × conf`, `conf = n/(n+8) × liquidity`; 7d/30d/whole-league shipped; prediction = recency-weighted same-day analog, ≥2 leagues. | "Design from deep research (quant methodology + PoE2 asset classes) then a /simplify pass that cut the multi-metric weighted-z score down to return×confidence for v1." |
| 2026-09-13 21:57 | `622ecb3` | + numeraire toggle Divine / Mirror / Hinekora's Lock | owner 19:01 |
| 2026-09-14 07:04 | `f366684` | Horizons → **1d/3d/7d** (default 3d) | owner: "leagues in poe move fast" |
| 2026-09-14 07:36 | `4d7b145` | `hold = ret × conf(depth × liq) × stab`; ±1-day median smoothing of endpoints; `liq = min(1, valvol/30M ex/day)` (value-weighted, not units); `stab = max(0.15, 1+mdd)` | Essences showed +3271% from two outlier closes (0.0028 ↔ 0.094 div); Omen of Whittling (smooth 1.08→5.59 div) was buried. Verified only on the winners. |
| 2026-09-16 | `f637db3` | + DTW league weights into `_predict` (league-arc) | Strategy phase 3. Later measured nearly inert (Kish ESS 3.76/4). |
| 2026-09-20 | `0180285` / 0.3.2 | `log(1+ret) + CAUTION_K·log(1+mdd)`, k=2 (slider 0–6); floor = top 50% of the day's traded value AND n≥4; cap mdd ≥ −40% | sign bug; backtests in §4 |
| 2026-09-21 | `c9ca0a0` / 0.3.3 | Forecast reads start days N±5 (`PRED_WINDOW`), band pooled; shown only as 1–3 arrows (3d/7d), dashes on 1d, hidden after league-day 14 | §4 |

**Considered and rejected (with the reason recorded at the time):**
- *Weighted-z composite* — rejected by /simplify as unexplainable and untunable. It was the sign-safe form.
- *Calmar/Sortino/Sharpe columns* — deferred at v1. Lane A (2026-09-15) re-proposed Sortino/Calmar/VaR-CVaR as "Hold risk columns". The owner steer that day recast risk as liquidity and decay, not solvency ("no shorting, no leverage, no ruin").
- *EWMA momentum blend `β·analog + (1−β)·EWMA·Δ`* — deferred: "a second free parameter you can't validate yet".
- *Unit-volume liquidity floor (`VOL_FLOOR=200`)* — replaced 2026-09-14: it gave a 3.7k-unit essence the same confidence as 40M-unit Chaos and penalised low-unit, high-value blue chips.
- *Absolute value floor 30M ex/day* — replaced 2026-09-20: 0% coverage in the first 30 days; 99 of ~118 early days empty.
- *`liq` multiplier* — IC ≈ 0; it favours big, not steady. It encodes a product preference ("parkable"), not a forecast. Replaced by a relative floor.
- *Stripping multipliers with no filter* — crash rate 6% → 18%.
- *k = 3 or higher* — costs 5.6pp of return for no crash improvement; the top-10 drawdown is flat at −14.0% from k=3 up.
- *Drawdown caps of −35%/−30%/−20%/−15%* — cut Mirror/Hinekora on 25–35% of early days; −20%/−15% raise crashes to 8%/12% because eligibility collapses.
- *Israelsen `stab^sign(ret)`* — offered by the research; the log-space dial was chosen instead as continuous and sign-safe.
- *Shrink toward the cross-sectional mean instead of 0; Lin/Louis pairwise-dominance ranks `Σ P(θi>θj)`; LCB ranking* — raised in report a5945. LCB was rejected as burying thin items; the other two were never adopted.
- *Omega ratio* — noted as the only sign-free ratio; not adopted.
- *Renaming the board and dropping the forecast* — rejected after the forecast measured positive IC outside the permutation null.
- *Day-blind forecast average* — beats `_predict` overall, but its edge is in the late-league dead zone. A finite ±5 window was adopted.
- *Blending the forecast into the ranking with a tuned weight* — deferred (Gelman J<5). A fixed-weight blend is still open.
- *`MIN_PRED_LEAGUES` 2 → 3* — confounded; not justified.
- *Showing the ± band / a % forecast* — the band understates the 95% prediction interval 4–22×; replaced by arrows.
- *"Whole-league horizon"* — in the original design (weighted 0.40, "reward consistency"); dropped by `f366684`. Never re-tested.

---

## 4. Key backtest results (2026-09-20/21, `bc10d31b`)

Method: walk each past league day by day and score using only data available at day t. Measure the
realized forward return and take the daily cross-sectional Spearman IC. There were 4 past leagues
(166k–172k observations) for the score and 3 target leagues for the forecast (it needs ≥2 prior
leagues). Everything below is the daily-close variant; production also uses hourly exchange cards.

- **Measurement trap:** IC(trailing ret, 3d) by gap between the score date and the forward window: gap 0
  −0.205, gap 1 −0.110, **gap 2 +0.009**, gap 5 +0.026. Always use gap ≥ 2 for score numbers (`_smooth`
  spans ±1 day). The forecast needs no gap.
- **Score IC by league day (7d):** 1–3 +0.208 · 4–7 **+0.281** · 8–14 +0.241 · 15–30 +0.177 · 31–60 +0.006 · 61+ −0.012.
  The top-10 basket beats the day's median by +24pp over 7d with a 6% crash rate.
- **Thin assets:** bottom liquidity decile, 63% move more than 50% in a week; top decile, 10%.
- **Filters (basket return / crash rate):** production +0.170/6%; ret alone +0.077/**18%**; ret +
  valvol≥100k & n≥4 **+0.235**/7%; Israelsen +0.225/6%.
- **k dial `log(1+ret)+k·log(1+mdd)`:** k=0.5 +0.249/7%/top-10 mdd −31.7%; k=1 +0.201/6%/−23.4%;
  **k=2 +0.192/5%/−15.2%**; k=3 +0.136/5%/−14.0%; k≥3 flat at −14.0%; old production +0.193/5%/−22.7%.
- **Drawdown cap:** none +0.192; −50% +0.195; **−40% +0.193 (crash 5%, top-10 mdd −14.3%)**; −35% +0.226;
  −30% +0.228/6%; −20% +0.255/8%. Anchor exclusion rate on early days at −35%: Mirror 25%, Hinekora 27%;
  at −40%: 0%.
- **Rarity ≠ risk:** a relative value floor keeps Mirror 93%, Hinekora 93%, Divine 95% of early days.
  "Steadiness and turnover predict crash risk about equally, so turnover was only ever a proxy; drawdown
  measures the intended thing directly."
- **Forecast IC (gap 0):** 1d +0.065, 3d +0.082, 7d +0.054 overall. 7d by phase: 4–7 **+0.533**, 8–14
  +0.283, 15–30 −0.070. Permutation null mean ≈ 0.
- **Forecast window ladder (3d, days ≤14):** ±0 +0.263 → ±5 **+0.317** → ±7 +0.320 → day-blind +0.301.
  The lag curve shows an early-league "broad, smooth, entirely positive hump" and a late league "near zero
  and sign-flipping".
- **Arrows (0.3.3):** early league 3d up arrows rose 75% (chance 63%), down fell 60% (chance 37%); 7d
  84%/69% (chance 65%/35%); 1d down fell 46% vs 48% chance (coin flip). After day 14, a 3d down arrow fell
  16% vs 30% chance.
- **Cost:** ±5 window on the live board: 3.57 ms (vs 0.51 ms at ±0).

---

## 5. What the 2026-09-13 domain research said about stores of value in PoE2

(Report a14d, live poe2scout pull 2026-09-13; the playbook report a1481, 2026-09-15.)
- Divine is the reserve currency and rises all league in Ex terms (the API shows 28 → 67 → 104 → 127 ex over
  the first days; ≈100–130 early → ≈390–430 late per timesaver.gg). Mirror (763k ex) and Hinekora's Lock (181k
  ex) are "the ceiling holds" and numeraire anchors.
- **Late-league appreciators** (supply-throttled crafting mats): targeted-removal Omens (Sinistral/Dextral
  Annulment and Erasure, Whittling, Chance), Ancient/Potent Liquid Emotions, Greater/Perfect/named essences,
  Refined catalysts, L20 uncut gems, top fragments/keys. Omen of Sinistral Annulment is *"cited as spiking in
  late-league phases"*.
- **Early-dump commodities** (bulk-farmed, negative drift): splinters, base essences, base catalysts, low
  runes. Expedition artifacts swing +130%/−90% and are *"not a clean store of value"*.
- *"Item prices decay over a league"*: most items peak in week 1, Exalts/runes peak in week 2, and there is
  an end-of-league liquidation crash.
- These are community sources (§6.12), **unverified** against primary data except the live poe2scout prices.

---

## 6. Sources

Status labels are the ones the original research used:
- **VERIFIED** — the agent extracted the text from the primary PDF/HTML or the pinned source file and quoted it verbatim.
- **VIA FETCH** — returned by a summarizing fetcher; the agent did not see the surrounding text. Verify before citing.
- **UNVERIFIED** — paywalled, 403, secondary summary only, or the agent's own arithmetic/analysis.
- **DOMAIN KNOWLEDGE** — named with no retrieval (the 2026-09-13 quant report said it was "Answering from domain knowledge").

Report keys: **Q13** = agent a7aac (2026-09-13 quant methodology); **A13** = a14d (asset classes);
**S13** = aeb93 (simplify); **LA** = a7a55 (2026-09-15 quant lane A); **PB** = a1481 (playbook);
**R1** = a5945 (shrinkage/ranking); **R2** = afc2d (momentum/forecast/framing); **R3** = a10ba
(small-sample/uncertainty display); **R4** = aca34 (risk-adjusted/composites); **R5** = a008b (library
source); **R6** = a0a7f (event windows/overlap); **R7** = a6188 (Heston–Sadka/KLN); **BUG** / **HO** =
the two repo docs. The full reports are verbatim in Appendices A–I.

### 6.1 Momentum vs short-term reversal: what horizon a trailing return predicts
Supports: Defect 2 of the bug doc (1–7d is the reversal horizon in equities). Our own data overruled it
(§4, gap-corrected IC ≥ 0). Most relevant to "Hold over-weights recent risers".

| Source | Link | Quote (verbatim) | Status |
|---|---|---|---|
| Jegadeesh & Titman (1993), "Returns to Buying Winners and Selling Losers", *JF* 48(1) 65–91 | https://www.bauer.uh.edu/rsusmel/phd/jegadeesh-titman93.pdf · https://onlinelibrary.wiley.com/doi/abs/10.1111/j.1540-6261.1993.tb04702.x | Abstract: "…generate significant positive returns over 3- to 12-month holding periods…part of the abnormal returns generated in the first year after portfolio formation dissipates in the following two years." p.67: "…very short-term return reversals (1 week or 1 month), or very long-term return reversals (3 to 5 years)…practitioners who use relative strength rules base their selections on price movements over the past 3 to 12 months." p.68: "By skipping a week, we avoid some of the bid-ask spread, price pressure, and lagged reaction effects…" | VERIFIED (R2; PDF extraction) |
| Asness, Moskowitz & Pedersen, "Value and Momentum Everywhere" (NBER SI 2008 draft; *JF* 2013) | https://users.nber.org/~confer/2008/si2008/AP/pedersen.pdf p.5 | "…past 12-month cumulative raw return on the asset…skipping the most recent month's return, MOM2-12. We skip the most recent month, which is standard in the momentum literature, since there exists a reversal or contrarian effect in returns at the one month level…" | VERIFIED (R2) |
| Jegadeesh (1990), "Evidence of Predictable Behavior of Security Returns", *JF* 45(3) 881–898 | https://ideas.repec.org/a/bla/jfinan/v45y1990i3p881-98.html | "The negative first-order serial correlation in monthly stock returns is highly significant…the twelve-month serial correlation is particularly strong…2.49 percent per month" | VERIFIED abstract (R2) |
| Lehmann (1990), "Fads, Martingales, and Market Efficiency", *QJE* 105(1) 1–28 | https://econpapers.repec.org/article/oupqjecon/v_3a105_3ay_3a1990_3ai_3a1_3ap_3a1-28..htm | "…the 'winners' and 'losers' one week experience sizeable return reversals the next week…" | VERIFIED abstract (R2) |
| Lo & MacKinlay (1990), "When Are Contrarian Profits Due to Stock Market Overreaction?", *RFS* 3(2) 175–205 | https://econpapers.repec.org/RePEc:oup:rfinst:v:3:y:1990:i:2:p:175-205 | "If returns on some stocks systematically lead or lag those of others, a portfolio strategy that sells 'winners' and buys 'losers' can produce positive expected returns, even if no stock's returns are negatively autocorrelated…" | VERIFIED abstract (R2) — dissent: cross-autocorrelation |
| Da, Liu & Schaumburg, NY Fed Staff Report 513 / *Management Science* 60(3) 658–674 | https://www.newyorkfed.org/medialibrary/media/research/staff_reports/sr513.pdf | "Short-term return reversal…robust and of economic significance. Jegadeesh (1990)…documents profits of about 2% per month over 1934-1987…"; sentiment vs liquidity explanations; "Avramov et al. (2006) find that the standard reversal strategy profits mainly derive from positions in small, high turnover, and illiquid stocks."; "Investors overreact to firm-specific news but underreact to industry-specific news." | VERIFIED (R2) |
| Nagel (2012), "Evaporating Liquidity", *RFS* 25(7) | https://www.nber.org/system/files/working_papers/w17653/w17653.pdf | "The returns of short-term reversal strategies in equity markets can be interpreted as a proxy for the returns from liquidity provision." | VERIFIED abstract (R2) |
| Avramov, Chordia & Goyal (2006), *JF* 61(5) 2365–2394 | https://econpapers.repec.org/article/blajfinan/v_3a61_3ay_3a2006_3ai_3a5_3ap_3a2365-2394.htm | "The largest reversals…occur in high turnover, low liquidity stocks…However, the contrarian trading strategy profits are smaller than the likely transactions costs." | VERIFIED abstract (R2) |
| Hou, Xue & Zhang (2020), "Replicating Anomalies", *RFS* 33 | https://www.nber.org/system/files/working_papers/w23394/w23394.pdf | "Prominent variables that do not survive our replication include the Jegadeesh (1990) short-term reversal…"; p.19: "…Srev decile earns on average only −0.26% per month (t = −1.31)…" | VERIFIED (R2) — dissent |
| Zaremba, Bilgin, Long, Mercik & Szczygielski (2021), "Up or down? Short-term reversal, momentum, and liquidity effects in cryptocurrency markets", *IRFA* 78 | https://ideas.repec.org/a/eee/finana/v78y2021ics1057521921002349.html · https://www.sciencedirect.com/science/article/pii/S1057521921002349 | "…the cryptocurrencies with low last day's return significantly outperform their counterparts with high last day's return." (only the largest coins show daily momentum) | Abstract VERIFIED; the "largest coins" resolution is from a publisher summary (R2) |
| Moskowitz & Grinblatt (1999) industry momentum | cited inside Da/Liu/Schaumburg | — | UNVERIFIED (cited only) |
| Time-series momentum (Moskowitz, Ooi & Pedersen 2012, *JFE*) | https://www.sciencedirect.com/science/article/pii/S0304405X11002613 | — | Link only (LA); not quoted |
| Cross-sectional momentum & liquidity artifacts (blog) | https://vadim.blog/extreme-move-equity-screen-liquidity/ | — | Link only (LA) |
| **Our own measurement** (supersedes the above for this market) | BUG §Experiments, HO "Read this before…" | gap-corrected IC(ret,3d) +0.009 to +0.026; score IC +0.28 in days 4–7 | Measured 2026-09-20 |

### 6.2 Return seasonality: the basis of Hold's forecast (`_predict`)
Supports: the league-phase analog forecast. Also the finding that widening the start window is licensed
only when adjacent periods share the same expected return, which our lag curve shows is true early and
false late.

| Source | Link | Quote (verbatim) | Status |
|---|---|---|---|
| Heston & Sadka, "Seasonality in the Cross-Section of Stock Returns" (Oct 2006 manuscript; published *JFE* 87(2) 2008, 418–445) | https://w4.stern.nyu.edu/finance/docs/pdfs/Seminars/063f-sadka.pdf · published (paywalled) https://www.sciencedirect.com/science/article/abs/pii/S0304405X0700195X · SSRN https://papers.ssrn.com/sol3/papers.cfm?abstract_id=687022 | "Therefore we choose a methodology based on returns over a single month."; "…we sort on noncontiguous months."; "…when sorting only on annual lags 24, 36, 48, and 60 the decile 1 winners outperformed decile 10 losers by 67 basis points."; §5.6 "…12-month historical return is 115 points per month…13-month…less than −30 basis points…14-month…−50 basis points…the sharp difference between returns in one month and returns in adjacent months." | Manuscript VERIFIED (R7, 2026-09-21). Published JFE text UNVERIFIED. NB: R2 (2026-09-20) could not extract a verbatim quote and BUG lists "Heston & Sadka verbatim" as unverified. R7 later verified it from the manuscript, and HO lists it as verified. |
| Keloharju, Linnainmaa & Nyberg (2016), "Return Seasonalities", *JF* 71(4) 1557–1590 | https://onlinelibrary.wiley.com/doi/abs/10.1111/jofi.12398 · https://research.aalto.fi/en/publications/return-seasonalities/ · SSRN https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2224246 | Abstract: "A strategy that selects stocks based on their historical same-calendar-month returns earns an average return of 13% per year. We document similar return seasonalities in anomalies, commodities, and international stock market indices, as well as at the daily frequency…" | Abstract VERIFIED (R2). **Full JF text UNVERIFIED** (closed access). |
| Keloharju, Linnainmaa & Nyberg, "Common Factors in Return Seasonalities", NBER WP 20815 (Dec 2014) | https://www.nber.org/system/files/working_papers/w20815/w20815.pdf | Eq. (9): "We estimate µ̂_i,t by computing each stock's average same-calendar-month return from the prior 20-year period…we demean stock returns in the cross section before taking the average. We include stocks that have at least five years of historical data at time t."; "In March 1964, for example, we sort on either the average March…or non-March…returns in 1944–63." | VERIFIED (R7) |
| Keloharju, Linnainmaa & Nyberg, "Seasonal Reversals in Expected Stock Returns" (Oct 2018 WP; published *JFE* 139(1) 2021, 138–161) | https://www.nasdaq.com/docs/Seasonal%20Reversals%20in%20Expected%20Stock%20Returns.pdf · published https://www.sciencedirect.com/science/article/abs/pii/S0304405X20301951 | "…averaging leaves the signal-to-noise ratio unchanged."; "…if µ_i,1 + ··· + µ_i,12 = 0, the average return over a year does not contain any information about expected returns."; the "Same-month" regression uses months t−60, t−48, t−36, t−24; "…this combination should better predict returns than either of the two proxies in isolation." | WP VERIFIED (R7); JFE text UNVERIFIED |
| Taiwan replication (2025, secondary) | https://www.impactio.com/publication-attachments/2075/832163694.pdf | "Stocks are sorted into decile portfolios according to their average close-to-close returns in the same calendar month over the previous one to five years…" | Quoted by R7; secondary |
| Hirshleifer, Jiang & DiGiovanni, "Mood betas and seasonalities in stock returns", NBER w24676 | — | — | Candidate only, not read (R7) |

### 6.3 Widening the forecast's start day: event windows and overlapping data
Supports: `PRED_WINDOW = 5` and pooling the band so it widens instead of shrinking (0.3.3).

| Source | Link | Quote (verbatim) | Status |
|---|---|---|---|
| MacKinlay (1997), "Event Studies in Economics and Finance", *JEL* XXXV 13–39 | https://www.bu.edu/econ/files/2011/01/MacKinlay-1996-Event-Studies-in-Economics-and-Finance.pdf · https://business.unr.edu/faculty/liuc/files/badm742/mackinlay_1997.pdf | p.14 "It is customary to define the event window to be larger than the specific period of interest."; p.21 CAR eq.(10)–(11) variance "(τ₂ − τ₁ + 1) σ²"; "tests with one event observation are not likely to be useful so it is necessary to aggregate."; p.35 "The usual method of handling this problem is to expand the event window to two days…the costs are worth bearing rather than to take the risk of missing the event."; p.34 "…substantial payoff in terms of increased power from reducing the sampling interval." | VERIFIED from page images (R6) |
| Brown & Warner (1985), "Using Daily Stock Returns: The Case of Event Studies", *JFE* 14 3–31 | https://leeds-faculty.colorado.edu/bhagat/brownwarner1985.pdf | p.15 §4.3.2 "As expected, the power of the tests decreases when the abnormal performance occurs over the (−5, +5) interval rather than at day 0…the rejection frequency…is 13.2%, compared to the earlier figure of 79.6%…" | R6 marks VERIFIED (text extracted). **HO lists the 79.6%→13.2% figure as "not located in our own extraction"; the two records disagree.** Re-verify before citing. |
| Kothari & Warner (2007), "Econometrics of Event Studies", *Handbook of Corporate Finance* Vol.1 ch.1 | https://www.jufinance.com/mag/dba_19/event_study_chapter_1_2008_vol_1.pdf · SSRN https://papers.ssrn.com/sol3/papers.cfm?abstract_id=608601 | §3.5 "…short-horizon methods are quite powerful if (but only if) the abnormal performance is concentrated in the event window…That power…is decreasing in horizon length is not surprising, but the empirical magnitudes are dramatic." | VERIFIED (R6) |
| Hedegaard & Hodrick, "Estimating the Risk-Return Trade-off with Overlapping Data Inference", NBER WP 19969 (2014); *J. Banking & Finance* 67 (2016) 135–145 | https://www.nber.org/system/files/working_papers/w19969/w19969.pdf · https://www.nber.org/papers/w19969 · published https://www.sciencedirect.com/science/article/abs/pii/S0378426616300103 | "…overlapping data inference (ODIN)…"; p.18 "…the average standard error for the ODIN-GARCH model is 84.8% of its basic counterpart…a 15.2% reduction…"; p.30 "…the average of the individual estimates…standard error…is the same asymptotically as…the ODIN estimator."; p.26 "…the estimate moves slowly with the sampling start date."; p.27 "…the ODIN model recognizes the variation that comes from changing the starting date resulting in a larger standard error."; §4.4 "…we use only relatively long samples in which the overlap remains a small fraction of the sample size." | WP VERIFIED (R6, HO); published text UNVERIFIED |
| Britten-Jones, Neuberger & Nolte, "Improved Inference and Estimation in Regression With Overlapping Observations", *JBFA* 38 (2011) 657–683 | https://warwick.ac.uk/fac/soc/wbs/subjects/finance/faculty1/anthony_neuberger/improved.pdf | "…Hansen-Hodrick and Newey-West standard errors tend to be severely biased down." | VERIFIED (R6) |
| Boudoukh, Richardson & Whitelaw (2008), "The Myth of Long-Horizon Predictability", *RFS* 21:4 1577–1605 | https://pages.stern.nyu.edu/~rwhitela/papers/mlhp%20rfs08.pdf | p.1584 "…for j close to k the estimators are almost perfectly correlated…the limited amount of independent information across multiple horizons." | VERIFIED (R6) |
| Boudoukh, Israel & Richardson (2019), "Long-Horizon Predictability: A Cautionary Tale", *FAJ* 75:1 | https://www.tandfonline.com/doi/full/10.1080/0015198X.2018.1547056 | — | UNVERIFIED (paywalled) |
| Hansen & Hodrick (1980), *JPE* 88:5 | — | — | UNVERIFIED (paywalled; known only via Hedegaard–Hodrick) |
| Campbell, Lo & MacKinlay, *Econometrics of Financial Markets* ch.4 | — | — | UNVERIFIED (book) |
| Newey & West (1987); Brown & Warner (1980); Richardson & Smith (1991); Ball & Torous (1988); Hodrick (1992); Richardson & Stock (1989); Valkanov (2003); Ang & Bekaert (2007) | — | — | UNVERIFIED (cited only) |
| Variance-ratio table for averaging m overlapping δ-day returns | R6 §2 | δ=7: w=5 → 0.50; δ=14: w=3 → 0.84 | Agent's own arithmetic |
| "Bias from including a different regime" in a shifted-start average | — | — | **No source exists (R6, HO).** Our lag curve stands in for it. |

### 6.4 Few seasons: small-sample estimation, pooling, analog forecasting
Supports: why the ± band was dropped, why blend weights can't be tuned on 3–4 leagues, and why recency
weighting is fine.

| Source | Link | Quote (verbatim) | Status |
|---|---|---|---|
| Gelman (2006), "Prior distributions for variance parameters in hierarchical models", *Bayesian Analysis* 1:3 515–533 | https://sites.stat.columbia.edu/gelman/research/published/taumain.pdf | §7.1 "…unless the number of groups J is low (below 5, say). If J is low, the uniform prior density tends to lead to high estimates of σ_α…"; §5.2 "…problems arise if the number of groups J is much smaller…"; §2.2 "…as long as the number of groups J is at least 3." | VERIFIED (R6, HO) |
| Andersen & Bollerslev (1998), "Deutsche Mark–Dollar Volatility…", *JF* 53:1 219–265 | https://public.econ.duke.edu/~boller/Published_Papers/jf_98.pdf | p.237 "…we allow for a flexible functional form that adapts well to the smooth cyclical pattern…Fourier flexible form (FFF)…"; p.245 "…excellent fit using only four sets of sinusoids." | VERIFIED (R6) |
| Andersen & Bollerslev (1997), *J. Empirical Finance* 4 115–158 | https://finance.martinsewell.com/stylized-facts/volatility/AndersenBollerslev1997b.pdf | — | Read, not quoted (R6) |
| Hyndman & Athanasopoulos, *FPP3* "Useful predictors" | https://otexts.com/fpp3/useful-predictors.html | "With Fourier terms, we often need fewer predictors than with dummy variables, especially when m is large" | VERIFIED live (R6) |
| Miller & Williams (2003) *IJF* 19:4 669–684; (2004) *IJF* 20:4 529–549 (shrinking seasonal factors) | https://ideas.repec.org/a/eee/intfor/v19y2003i4p669-684.html · https://ideas.repec.org/a/eee/intfor/v20y2004i4p529-549.html | — | UNVERIFIED (403; no abstract) |
| Boost Math Toolkit, "Confidence Intervals on the Standard Deviation" | https://www.boost.org/doc/libs/release/libs/math/doc/html/math_toolkit/stat_tut/weg/cs_eg/chi_sq_intervals.html (mirror read: https://home.cc.umanitoba.ca/~psgendb/doc/local/pkg/CASAVA_v1.8.2-build/opt/bootstrap/build/boost_1_44_0/libs/math/doc/sf_and_dist/html/math_toolkit/dist/stat_tut/weg/cs_eg/chi_sq_intervals.html) | "With just 2 observations the limits are from 0.445 up to to 31.9…" | VERIFIED, and the arithmetic reproduced (R3) |
| Wikipedia, "Unbiased estimation of standard deviation" (Duncan; Johnson/Kotz/Balakrishnan) | https://en.wikipedia.org/wiki/Unbiased_estimation_of_standard_deviation | c₄: n=2 0.7978845608; n=3 0.8862269255; n=4 0.9213177319; Bessel's correction "…some, but not all of the bias…" | VERIFIED (R3) |
| Prediction-interval multipliers 22.0/6.1/4.1× pstdev (n=2/3/4); Kish ESS 1.914/2.683/3.286 for `0.65^rank` | R3 | — | Agent arithmetic, recomputed (BUG) |
| Valliant, PracTools "Design Effects" vignette (Kish deff) | https://cran.r-project.org/web/packages/PracTools/vignettes/Design-effects.html | "deff_K = 1 + relvar(w)…"; "extremely restrictive assumptions" | VIA FETCH (R3) |
| van den Dool (1994), "Searching for analogues, how long must we wait?", *Tellus A* 46(3) 314–324 | https://tellusjournal.org/articles/10.3402/tellusa.v46i3.15481 | "It would take a library of order 10^30 years to find 2 observed flows that match…" | VIA FETCH (R3). Supports "same league-day ≠ analog; it is climatology". |
| Delle Monache et al. (2013), "Probabilistic Weather Prediction with an Analog Ensemble", *MWR* 141:3498 | — | — | UNVERIFIED (blocked) |
| Hyndman & Kostenko (2007), "Minimum sample size requirements for seasonal forecasting models", *Foresight* 6:12–15 | https://robjhyndman.com/publications/minimum-sample-size-requirements-for-seasonal-forecasting-models/ | "…Real data often contain a lot of random variation, and then many more observations are required." | VERIFIED abstract (R3) |
| Hyndman, "Fitting models to short time series" | https://robjhyndman.com/hyndsight/short-time-series/ | "There is no guarantee that a fitted model will be any good for forecasting…" | VIA FETCH (R3) |
| "Two cycles is the minimum" rule of thumb | — | — | Folklore; no derivation found (R3) |

### 6.5 Risk-adjusted scoring, the negative-return pathology, composites
Supports: the 0.3.2 fix (sign-safe log-space score), drawdown as the "safe" dimension, and the options for
a steadiness/inflation-resistance term.

| Source | Link | Quote (verbatim) | Status |
|---|---|---|---|
| Israelsen (2005), "A refinement to the Sharpe ratio and information ratio", *J. Asset Management* 5(6) | https://ideas.repec.org/a/pal/assmgt/v5y2005i6d10.1057_palgrave.jam.2240158.html | "By modifying the denominator, both the Sharpe ratio and information ratio provide correct rankings during periods of negative excess returns." | VERIFIED abstract (R4) |
| CFA Institute Digest, "Refining the Sharpe Ratio" (Magiera, 2010) | https://rpc.cfainstitute.org/research/cfa-digest/2010/02/refining-the-sharpe-ratio-digest-summary | "When excess return is negative, the Sharpe ratio is also negative, which can be counterintuitive."; "…add an exponent to the denominator…" | R4 VERIFIED; R1 VIA FETCH; BUG VERIFIED |
| Kidd (2012), "The Sortino Ratio", CFA Institute | https://rpc.cfainstitute.org/sites/default/files/-/media/documents/code/gips/the-sortino-ratio.pdf | "S = (Mean portfolio return – MAR)/Downside deviation."; "…if the majority of the returns are positive, downside deviation can be significantly understated."; "Just because nothing bad happened doesn't mean you didn't take any risk." | VERIFIED (R4) |
| Wikipedia: Calmar ratio / Sterling ratio / Omega ratio / Sharpe ratio | https://en.wikipedia.org/wiki/Calmar_ratio · https://en.wikipedia.org/wiki/Sterling_ratio · https://en.wikipedia.org/wiki/Omega_ratio · https://en.wikipedia.org/wiki/Sharpe_ratio | Calmar: "average annual rate of return for the last 36 months divided by the maximum drawdown…"; Omega "Ω(θ) = ∫θ^∞ [1−F(r)]dr / ∫−∞^θ F(r)dr"; Sharpe "…a negative Sharpe ratio can be made higher by…increasing volatility (a bad thing)." | R4 VERIFIED; Sharpe via R1 VIA FETCH |
| LuxAlgo: Calmar ratio; Martin ratio / Ulcer Index | https://www.luxalgo.com/library/concept/calmar-ratio/ · https://www.luxalgo.com/library/concept/martin-ratio/ | "…the ratio tends to drift down with track-record length."; "Ulcer Index = sqrt( mean( D_i^2 ) )…Martin ratio = (annualized return - risk-free rate) / Ulcer Index" (Martin & McCann 1989) | VERIFIED (R4); practitioner source |
| Quantt, "Calmar ratio explained" | https://www.quantt.co.uk/resources/calmar-ratio-explained | "In practice, most fund databases filter out managers with negative Calmar ratios during screening." | VERIFIED (R4); practitioner |
| PortfoliosLab Calmar tool | https://portfolioslab.com/tools/calmar-ratio | "Values below zero do not convey any meaningful information." | UNVERIFIED (403) |
| Valuefy, "Negative Sharpe Ratio" | https://www.valuefy.com/insights/negative-sharpe-ratio-down-market | "…multiply by volatility instead of dividing by it"; "σp^(ER/\|ER\|)" | VERIFIED (R4) / VIA FETCH (R1); vendor blog |
| Zhitlukhin, "Monotone Sharpe ratios…", arXiv:1809.10193 | https://arxiv.org/pdf/1809.10193 · https://arxiv.org/abs/1809.10193 | "…the Sharpe ratio lacks the property of monotonicity…" | VERIFIED (R4) |
| Cheridito & Kromer (2013), "Reward-Risk Ratios", *J. Investment Strategies*; SSRN 2144185 | https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2144185 | "good RRRs should at least be monotonic…" | UNVERIFIED (403; secondary paraphrase via lacuna.tiptreesystems.com) |
| "Omega is oversold" (arXiv:1911.10254) | https://arxiv.org/abs/1911.10254 | "…for returns that have elliptic distributions…the optimal portfolio according to Omega ratio is the same as…Sharpe ratio." | VERIFIED (R4) |
| Morningstar MRAR: Danske Invest reproduction; Morningstar MRAR factsheet; Mutual Fund Observer | https://www.danskeinvest.com/pdf/morningstar_en.pdf · https://www.morningstar.com/content/dam/marketing/apac/au/pdfs/Legal/MRARIllustrated_Factsheet.pdf · https://www.mutualfundobserver.com/2014/03/morningstars-risk-adjusted-return-measure/ | "…emphasizing mostly to downward return fluctuations, while rewarding consistent performance."; "Morningstar risk is then calculated as the difference between Morningstar Return and Morningstar Risk-Adjusted Return."; "A 'risk penalty' is subtracted from each fund's total return…with an emphasis on downward variation." | VERIFIED (R4); MFO is commentary. **The subtracted-penalty design is the closest real-world "rewards consistent performance" ranking.** |
| Morningstar downside-capture ratio | https://www.morningstar.com/investing-definitions/downside-capture-ratio | — | UNVERIFIED (403) |
| XBTO, "The Quality of Returns: Crypto Risk-Adjusted Performance" | https://www.xbto.com/resources/the-quality-of-returns-crypto-risk-adjusted-performance | "maximum drawdown…the single most important risk metric…"; "Lose 50%, and you need 100% to recover. Lose 80%, and you need 400%." | VERIFIED (R4); industry |
| MarketVector, "Rethinking Store of Value" | https://www.marketvector.com/insights/mvis-insights/rethinking-store-of-value | (argues store of value is structural: scarcity, no issuer, supply constraint) | UNVERIFIED (403). Relevant to "resists inflation": supply-throttled items. |
| OECD/JRC (2008), *Handbook on Constructing Composite Indicators*, ISBN 978-92-64-04345-9 | https://www.oecd.org/content/dam/oecd/en/publications/reports/2008/08/handbook-on-constructing-composite-indicators-methodology-and-user-guide_g1gh9301/9789264043466-en.pdf | p.115 "…can only be meaningfully aggregated by using geometric functions, provided that x is strictly positive."; p.32–33 "Geometric aggregations are better suited if the modeller wants some degree of non compensability…"; p.103 preferential independence; p.103–104 "…implied full compensability…" | VERIFIED (R4, BUG) |
| AutoTiers issue #1490 (penalty multiplier on negative score) | https://github.com/SuperFamousGuy/AutoTiers/issues/1490 | "…makes the score less negative, which inverts the intended penalty effect" | Low authority (R4). Do not cite. |
| Healthcare Economist, "Shrinkage estimators and composite quality scores" | https://www.healthcare-economist.com/2012/07/24/shrinkage-estimators-and-composite-quality-scores/ | (principle only) | R4, general |
| Grinold (1989) fundamental law; Grinold (1994) "Alpha is Volatility Times IC Times Score", *JPM* 20(4) 9–16; Ding & Martin (2017) "Redux", *J. Empirical Finance* 43 91–114 | https://jpm.iijournals.com/content/20/4/9 · https://www.sciencedirect.com/science/article/pii/S0927539817300543 · MSCI note https://www.msci.com/documents/10199/1645561/PI_Converting_Scores_Into_Alphas.pdf | α = volatility × IC × score | Attribution only; **formula body UNVERIFIED** (R2) |
| Sortino & van der Meer (1991); Young (1991) Calmar; James–Stein (1961) | — | — | DOMAIN KNOWLEDGE (Q13) |

### 6.6 Shrinkage, confidence, and ranking under uncertainty
Supports: `ret × depth` is a valid posterior mean (not a bug); a zero target is a choice; ranking by point
estimates has no optimality guarantee.

| Source | Link | Quote (verbatim) | Status |
|---|---|---|---|
| Lin, Louis, Paddock & Ridgeway (2006), "Loss Function Based Ranking in Two-Stage, Hierarchical Models", *Bayesian Analysis* 1(4) 915–946 | https://projecteuclid.org/journals/bayesian-analysis/volume-1/issue-4/Loss-function-based-ranking-in-two-stage-hierarchical-models/10.1214/06-BA130.pdf | p.918 "…the optimal ranks are neither the ranks of the observed data nor the ranks of the posterior means of the θs."; p.917 "…when the posterior distributions are stochastically ordered…ranks…are identical."; eq.(5) "R̄k(Y) = …Σⱼ pr(θk ≥ θj \| Y)"; abstract "…even optimal rank estimates can perform poorly in many real-world settings…" | VERIFIED (R1, BUG) |
| Goldstein & Spiegelhalter (1996), "League Tables and Their Limitations", *JRSS-A* 159(3) 385–443 | https://www.dcscience.net/Goldstein-Spiegelhalter-1996league-tables-RSS.pdf | §4.2 "…we can use such rankings as screening instruments, but not as definitive judgments…"; §5.2.2 "The multilevel model…has the effect of making the ranks even more uncertain"; discussion: shrinkage "can easily be presented as quite unfair" vs "shrinkage may reduce the risk of large errors" | VERIFIED (R1, BUG) |
| Ginestet, *Bayesian Decision-theoretic Methods for Parameter Ensembles* (PhD, Imperial), arXiv:1105.5004 | https://arxiv.org/pdf/1105.5004 | "…posterior means tend to overshrink…"; "Hierarchical shrinkage…is often seen as a desirable property…" | VERIFIED (R1) |
| Jewett et al. (2019), "Optimal Bayesian point estimates and credible intervals for ranking…" | https://rgangnon.org/publication/jewett-2019/jewett-2019.pdf | "…shrink observed health indices towards a regional mean if the health indices are based on few measurements only"; "…the indices are then simply ranked as if they were known constants." | VERIFIED (R1) |
| Rising, "Uncertainty in Ranking", arXiv:2107.03459 (R package `rankUncertainty`) | https://arxiv.org/abs/2107.03459 | "…the uncertainty in the ranks must be determined by the uncertainty in the parameter estimates." | VIA FETCH (R1) |
| Evan Miller, "How Not To Sort By Average Rating"; "Ranking Items With Star Ratings" | https://www.evanmiller.org/how-not-to-sort-by-average-rating.html · https://www.evanmiller.org/ranking-items-with-star-ratings.html | Wilson lower bound; scope "positive and negative ratings (i.e. not a 5-star scale)" | VIA FETCH (R1). Out of domain for signed returns. |
| EFAVDB, "How not to sort by average rating, revisited" | https://www.efavdb.com/ranking-revisited | "…any new, quickly-down-voted item will immediately be ranked below all others. This is extremely harsh and potentially unfair." | VIA FETCH (R1) |
| Wikipedia: Bayesian average; James–Stein estimator | https://en.wikipedia.org/wiki/Bayesian_average · https://en.wikipedia.org/wiki/James%E2%80%93Stein_estimator | "x̄ = (Cm + Σ xᵢ) / (C + n)"; "…shrinks the sample mean θ towards a more central mean vector ν" | VIA FETCH (R1) |
| Shen & Louis (1998); Gelman & Price (1999); Louis (1984); Ghosh (1992) | — | — | UNVERIFIED (403; cited via Lin et al./Ginestet) |

### 6.7 Combining a trailing score with the forecast
Supports: integrate before ranking; weight the forecast by measured skill; keep weights fixed.

| Source | Link | Quote (verbatim) | Status |
|---|---|---|---|
| Fitzgibbons, Friedman, Pomorski & Serban (AQR, 2016), "Long-Only Style Investing: Don't Just Mix, Integrate" | https://images.aqr.com/-/media/AQR/Documents/Insights/White-Papers/Long-Only-Style-Investing-Dont-Just-Mix-Integrate.pdf | "…integrating styles in long-only portfolio construction generates benefits by avoiding stocks with offsetting style exposures and including stocks with balanced positive style exposures." | VERIFIED (R2, BUG) |
| Alpha Architect, combine vs separate factor exposures | https://alphaarchitect.com/should-investors-combine-or-separate-their-factor-exposures/ | — | Link only (R2) |
| He & Litterman (1999), "The Intuition Behind Black-Litterman Model Portfolios" (Goldman Sachs) | https://people.duke.edu/~charvey/Teaching/BA453_2006/GS_The_intuition_behind.pdf | "The weight increases as the investor becomes more bullish on the view as well as when the investor becomes more confident about the view." | VERIFIED (R2) |
| Wang, Hyndman, Li & Kang, "Forecast combinations: an over 50-year review", arXiv:2205.04216 | https://arxiv.org/pdf/2205.04216 | §2.6 "…the simple average with equal weights often outperforms more complicated weighting schemes." | VERIFIED (R2) |

### 6.8 Showing uncertainty (why the ± band became arrows)

| Source | Link | Quote (verbatim) | Status |
|---|---|---|---|
| MCHB/DRC, "NSCH data suppression and display" (modified NCHS standard) | https://www.childhealthdata.org/docs/default-source/nsch-docs/nsch_data-supression-and-display_revised_4-13-20.pdf | "If an unweighted denominator is less than 30…suppressed and displayed as a dash (--)."; "…relative CI width is greater than 120% (1.2 times the estimate)…the estimate is displayed but may not be reliable." | VERIFIED (R3) |
| CDC/NCHS "Statistical reliability" | https://www.cdc.gov/nchs/hus/sources-definitions/statistical-reliability.htm | "Estimates identified as statistically unreliable are suppressed and replaced with an asterisk (*)" | VIA FETCH (R3) |
| NCHS primary thresholds (≥0.30 absolute; >130% relative; df<8); Ward `kg_nchs` | https://doi.org/10.1177/1536867X19874221 | — | UNVERIFIED (R3) |
| Gneiting, Balabdaoui & Raftery (2007), *JRSS-B* 69(2) 243–268 | https://sites.stat.washington.edu/raftery/Research/PDF/Gneiting2007jrssb.pdf | "…maximizing the sharpness of the predictive distributions subject to calibration" | VERIFIED (R3) |
| Padilla, Kay & Hullman (2022), "Uncertainty Visualization" | http://space.ucmerced.edu/Downloads/publications/Uncertainty_Visualization_Padilla_Kay_Hullman_2022.pdf | "uncertainty information is commonly ignored or mentally substituted for simpler information"; "…even with extensive instructions, viewers judgments are still influenced by deterministic construal errors…" | VERIFIED (R3) |
| Hullman, Resnick & Adar (2015), *PLOS ONE* 10(11): e0142444 | https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0142444 | "On no task was the mean absolute error less than 36 percentage points." | VERIFIED (R3) |
| Correll & Gleicher (2014), "Error Bars Considered Harmful", *IEEE TVCG* 20(12) | https://graphics.cs.wisc.edu/Papers/2014/CG14/Preprint.pdf | "The encoding should avoid 'all or nothing' binary encodings…" | VERIFIED (R3) |
| Joslyn & LeClerc (2012), *J. Exp. Psych: Applied* 18(1) 126–140 | https://www.apa.org/pubs/journals/features/xap-18-1-126.pdf | — | UNVERIFIED (retrieval failed) |
| Helske et al., "Can Visualization Alleviate Dichotomous Thinking?" | https://arxiv.org/abs/2002.07671 | — | Summarized only (R3) |
| Frontiers, "Visualizing Uncertainty for Non-Expert End Users…" | https://www.frontiersin.org/journals/computer-science/articles/10.3389/fcomp.2020.590232/full | — | Listed (R3) |

### 6.9 Framing a trailing ranking (regulatory and industry)

| Source | Link | Quote (verbatim) | Status |
|---|---|---|---|
| FINRA Rule 2210(d)(1)(F) | https://www.finra.org/rules-guidance/rulebooks/finra-rules/2210 | "Communications may not predict or project performance, imply that past performance will recur…" | VERIFIED (R2) |
| FCA COBS 4.6.2 R | https://www.handbook.fca.org.uk/handbook/COBS/4/6.html | "that indication is not the most prominent feature of the communication" | VERIFIED (R2) |
| SEC investor publication; investor.gov | https://www.sec.gov/about/reports-publications/investorpubsmfperformhtm · https://www.investor.gov/introduction-investing/investing-basics/investment-products/mutual-funds-and-exchange-traded-funds-etfs/mutual-funds | "While past performance does not necessarily predict future returns, it _can_ tell you how volatile a fund has been." | VERIFIED (R2) |
| Morningstar Medalist Ratings explainer | https://advhypo.morningstar.com/Enterprise/VTC/MorningstarMedalistRatingsExplainer.pdf | "Morningstar Rating 'Star Rating'…Backward-looking, quantitative…"; "…Forward-looking…" | VERIFIED (R2) |
| BETTER FINANCE on PRIIPs; ESAs advice | https://betterfinance.eu/priips/ · https://www.esma.europa.eu/sites/default/files/library/jc_2022_20_esa_advice_on_priips_regulation.pdf | — | UNVERIFIED (advocacy) |

### 6.10 Open-source library source pointers (R5, read 2026-09-20; pinned heads)

| Library @ commit | Function (file#lines) | What it is | Relevance |
|---|---|---|---|
| empyrical `master` @ `40f61b4f229df10898d46d08f7b1bdc543c0f99c` | `stability_of_timeseries` (empyrical/stats.py#L1471-L1498) | R² of OLS fit to `np.log1p(returns).cumsum()`; `len<2 → nan` | **Steadiness of the upswing.** It is the namesake of `stab`, not `1+mdd`. A straight line down also scores ≈1. |
| same | `calmar_ratio` (#L583-L596) | `annual_return / abs(max_dd)` if `max_dd<0` else nan | sign-safe ratio |
| same | `max_drawdown` (#L352-L402, L396) | `nanmin((cumulative - max_return)/max_return)` | our `mdd` convention |
| same | `sharpe_ratio` (#L694-L720), `sortino_ratio` (#L775-L800), `omega_ratio` (#L630-L650), `tail_ratio` (#L1518-L1528) | ratios; `len<2 → nan` (the idiom appears 7×) | refuse, don't shrink |
| quantstats `main` @ `fbd10daed0227aa0d10da6513f1b15e7e98d7fae` | `calmar` (L1672-L1677), `ulcer_index` (L1702), `ulcer_performance_index` (L1730-L1738), `serenity_index` (L1806-L1811) | Ulcer = sqrt(Σdd²/(n−1)); UPI = (comp−rf)/ulcer; Serenity = (Σret−rf)/(ulcer×pitfall) | depth+duration drawdown |
| same | `cpc_index` (L2225), `common_sense_ratio` (L2251), `profit_factor` (L2185-L2199), `win_rate` (L541-L545) | the only A×B×C products; every factor ≥ 0 | multiply only non-negative factors |
| same | `probabilistic_ratio` (L1236-L1252), `autocorr_penalty` (L824-L835), used in `sharpe` (L888-L892) / `sortino` (L1029-L1035) | n enters via the standard error; the penalty is ≥1 and multiplies the divisor | confidence is reported separately |
| same | `risk_of_ruin` (L1839-L1840), `kelly_criterion` (L2575) | standalone | — |
| quantstats issue #230 "CAGR and Sharpe ratio should have the same sign" (opened 2022-11-30, closed unfixed 2025-07-18) | https://github.com/ranaroussi/quantstats/issues/230 | "Use log returns for Sharpe/Sortino/CALMAR/... ratio computations, not simple returns." | log returns |
| ffn `master` @ `100440abc1d93c60a39be7248b2a6cb9b42db16a` | `calc_calmar_ratio` (ffn/core.py L2673), `calc_max_drawdown` (L1424-L1428), `calc_sharpe` (L1558), `calc_deflated_sharpe_ratio` (L2771-L2830, `n < 3 → NaN`) | ratios; refuse on thin data | — |
| ffn PR #285 "fix: use target downside deviation in Sortino ratio" | — | Sortino denominators disagree across libraries | — |
| vectorbt `master` | `calmar_ratio_1d_nb` (vectorbt/returns/nb.py#L254-L262; dead `return np.inf` at L261), `sharpe_ratio_1d_nb` (L338-L348) | — | — |
| PyPortfolioOpt `master` | `risk_models.py#L500-L507` (`shrunk_cov = delta * F + (1 - delta) * self.S`) | shrinkage = convex combination toward an explicit target | — |
| (2026-09-13, Q13) empyrical, quantstats, vectorbt, pandas-ta, ta, tsfresh, statsmodels | no URLs, DOMAIN KNOWLEDGE | Q13's verdict: ship zero scientific deps; "Use empyrical's Apache-2.0 source as your formula reference…Keep it in your dev-only requirements as a test oracle" | never done |
| (2026-09-15, LA) PyPortfolioOpt, Riskfolio-Lib, ruptures, statsmodels (coint/adfuller/STL), sklearn LedoitWolf, hmmlearn, Structural Theta (M4) | https://github.com/PyPortfolio/PyPortfolioOpt · https://github.com/PyPortfolio/PyPortfolioOpt/blob/main/pypfopt/hierarchical_portfolio.py · https://github.com/cottrell/hrp · https://riskfolio-lib.readthedocs.io/ · https://github.com/deepcharles/ruptures · https://centre-borelli.github.io/ruptures-docs/ · https://www.statsmodels.org/stable/install.html · https://www.statsmodels.org/stable/generated/statsmodels.tsa.stattools.coint.html · https://www.statsmodels.org/stable/generated/statsmodels.tsa.stattools.adfuller.html · https://www.statsmodels.org/stable/generated/statsmodels.tsa.seasonal.STL.html · https://scikit-learn.org/stable/modules/generated/sklearn.covariance.LedoitWolf.html · https://github.com/hmmlearn/hmmlearn · https://www.sciencedirect.com/science/article/pii/S0169207024000906 | links only | not Hold scoring |

### 6.11 Inflation-index methodology (2026-09-13 19:02, feeds the numeraire choice)
The "Inflation index methodology + OSS tools" agent (a977710dd727ae9c1,
`…/15b714b2…/subagents/agent-a977710dd727ae9c1.jsonl`) proposed rebasing a hard-numeraire price to
day-0 = 100, using a volume-weighted base over the first 24h, and a Törnqvist-style basket. This is the
origin of the "inflation index" that Hold's "resists inflation" framing sits on. The full report is in
Appendix J. It cites no URLs (unverified).

### 6.12 PoE2 domain sources (community; UNVERIFIED as economics, used for asset-class priors)
From A13 (2026-09-13): Switchblade Gaming currency tier list https://www.switchbladegaming.com/path-of-exile-2/currency-tier-list/ ·
Switchblade currency guide https://www.switchbladegaming.com/path-of-exile-2/currency-guide/ · Elyxir ritual farming
https://www.elyxir.gg/guide/path-of-exile-2/path-of-exile-2-ritual-farming-guide-best-patch-05-setup-for-omen-profit ·
Timesaver omens https://timesaver.gg/blog/poe2-omens-guide · Dads of Exile omens https://dadsofexile.com/omens ·
Timesaver distilled emotions https://timesaver.gg/blog/poe2-distilled-emotions-guide · Dads of Exile liquid emotions
https://dadsofexile.com/liquid-emotions · Timesaver soul cores https://timesaver.gg/blog/poe2-soul-cores-guide ·
PoE Overlay expedition history https://www.poeoverlay.com/market-history/poe2/runes-of-aldur/expedition · Timesaver
spend-or-save https://timesaver.gg/blog/poe2-spend-or-save-currency-before-reset-guide · Out of Games omens
https://outof.games/realms/poe2/economy/omens/ · live `api.poe2scout.com` (league `forbiddenrites`, 2026-09-13).
From PB (2026-09-15): Maxroll flipping https://maxroll.gg/poe2/resources/flipping-with-the-currency-exchange ·
Mobalytics https://mobalytics.gg/poe-2/guides/currency-flipping · timesaver Div/Ex https://timesaver.gg/blog/poe2-divine-to-exalt ·
timesaver early farming https://timesaver.gg/blog/poe2-early-currency-farming-guide · Switchblade Week 1 vs Week 4
https://www.switchbladegaming.com/path-of-exile-2/economy-guide-4/ · poe2fun catalysts https://poe2fun.com/guides/poe2-catalyst-guide ·
timesaver profit crafting https://timesaver.gg/blog/poe2-profit-crafting-guide · u4gm breach splinters
https://www.u4gm.com/path-of-exile-2/blog-path-of-exile-2-0.5-breach-splinter-guide · timesaver boss carry
https://timesaver.gg/blog/poe2-boss-carry-worth-it-guide · Medium PoE time-series
https://medium.com/@produde/path-of-exile-economy-a-time-series-analysis-b7af193d664a · poetrades poe.ninja guide
https://poetrades.net/poe-ninja-economy-guide/.

### 6.13 Disagreements between the old records (resolve before committing to docs)
- **Heston & Sadka verbatim:** R2 (2026-09-20) could not extract a quote, and BUG lists it as unverified.
  R7 (2026-09-21) verified it from the Oct 2006 NYU Stern manuscript, and HO lists it as verified. Only the
  published JFE 2008 text is unverified.
- **Brown & Warner 79.6% → 13.2%:** R6 says verified from the PDF (p.15 §4.3.2). HO says "reported by a
  research agent, not located in our own extraction".
- **CFA/Israelsen digest quote:** R1 marks it VIA FETCH, R4 and BUG mark it verified.
- **`ret × conf` defensibility:** R1/R4 call `depth` legitimate shrinkage. R5 calls the whole product "a
  local invention" with no upstream. Both are true: `depth` is a real technique (Bayesian average), just not
  from these libraries.

---

