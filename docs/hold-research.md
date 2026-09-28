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

## The smoke test — `ops/hold-backtest.py`

Replays Hold day by day through a league for every horizon the app offers (24h/3d/7d/14d), holds the
top 10 in equal parts from t+2 for that horizon, and grades the portfolio against `THRESHOLDS`: it must
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
3 days). The eligibility gate (value floor, 4 days, −40% cap) is unchanged. The horizon sets the return
column and the forecast, not the order.

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
