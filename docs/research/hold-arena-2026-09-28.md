# Hold arena, 2026-09-28 — the four candidates' rationale and sources (verbatim)

Record of the arena that chose Hold's ranking. The synthesis (base, grafts, rejections, verification) is in [`../hold-research.md`](../hold-research.md#arena-2026-09-28). Each candidate ran on Opus 5.5, read-only, graded by `ops/hold-backtest.py`. Their working files (scripts, backtest JSON) stayed in the session scratchpad.

## Cross-judge verdict

## Hold arena: cross-judge verdict

I re-ran everything myself. All four smoke tests pass (exit 0, `--workers 2`). All four `baseline.json` files are identical. Re-running Rise of the Abyssal reproduced each candidate's `all.json` cells exactly, so each file came from the submitted scorer. League calendar from the DB: Runes of Aldur (2026-05-29 → still running) overlaps Forbidden Rites (started 2026-09-04, a 98-day gap). The four holdout leagues do not overlap each other.

### Scores (0–5)

| | R1 smoke | R2 holdout | R3 day-24 | R4 grounding | R5 portability | Total |
|---|---|---|---|---|---|---|
| **C1** | 4: passes, but 14d vs_board is only +0.3 with 60% beat (5 graded days) | 2: vs_board 10↑/6↓, crash 10↑/4↓; owner 4↓ (Runes 84→77%), churn 12↓, chase 12↓ | 3: Emergent #12, Flux #25 (both out of the top 10). Lock #7, Light #11, Dextral #13, Mirror #19, Whittling not in the top 25. Uncut Spirit Gems #9/#10 | 4: Sharpe and timesaver quotes V-primary; rejected ideas backed by IC and crash ratio; discloses that signal choice saw the holdout | 4: stdlib, no leakage (record reads past ages ≤ t+19); neutral 0.5 for a missing record; loops recomputed every call | 17 |
| **C2** | 5: passes; 7d/14d crash ratio 0.00; owner 100% | 4: vs_board 11↑/5↓, crash 11↑/1↓, owner 4↑/0↓; churn 8↓, chase 12↓ (each ≤ +0.02) | 2: Lock #3, Mirror #8, five high-end omens in the top 19 (Whittling #15), **but Emergent #2 and Flux #4** | 4: IC by phase; robust to the crash line (−10/−20/0%); discloses the lookahead and that the current league chose between two forms | 3: smallest change (production + 1 signal + reweight). **Leak:** `survival` is day-blind and reads Runes of Aldur's days after each Forbidden Rites replay day (disclosed). The module-global cache would go stale in a long-running backend | 18 |
| **C3** | 5: passes with the widest margins (7d +24.7, 14d +53.5) | 3: vs_board 13↑/3↓, Fate 14d +3.0→+19.6; crash 7↑/4↓ with Rise worse at every horizon; owner 4↑/0↓; **churn worse 16/16**, chase 10↓ | 1: Emergent #4, Flux #7; Lock #8, Light #10, Dextral #14, Mirror #19, Whittling #32 | 5: Baur & Lucey quote V-primary from the PDF; new-item underperformance measured per league; IC table covers rejected signals too | 3: the no-lookahead proof rests on a **hard-coded "leagues ≥ 98 days apart"** (true today by exactly 0 days of slack), not a calendar cut. `ctx.get("k", …)` crashes if k is None. Missing record → rank 0 | 17 |
| **C4** | 5: passes; owner 90% | 1: vs_board 6↑/10↓, crash 7↑/9↓, owner 8↓ (Runes 84→72%), chase 11↓; only Dawn churn improves | 1: Emergent #5, Flux #7, Lock #12, Mirror out of the top 25; the author says the complaint is not fixed | 3: good IC work, but it keeps `depth` even though its own IC is negative in every phase; Menger quote relayed | 3: leak-free (`_predict` only to day 14); 7 signals with structural half weights is the largest surface | 13 |

No candidate meets R2's "churn and chase not worse" literally. C2's losses are the smallest (≤ 1–2 points).

### Recommended BASE: Candidate 2

C2 keeps production's frame: the same `_signals`, `_pct_ranks`, the "left out, never 0" rule, the settle, and the Caution dial. It adds one signal, `survival`, and halves `kept` and `trend` so recent momentum counts once. The diff to `holdscore.py` is the smallest of the four and the easiest to review. It also has the best holdout: crash ratio is worse in only 1 cell, and owner coverage never drops. Two fixes are required before porting:

1. **Close the leak.** Cut each past league's series at the calendar day of the replay: past age ≤ (current start − past start) + t. Needed while an earlier league is still running, which is the case today.
2. **Fix R3.** Borrow C1's rule: require `MIN_PRED_LEAGUES` (2) past leagues, and give an item with no record the **neutral 0.5 rank** instead of leaving it out. Emergent Possibility and Perfect Flux each have one earlier league, and survival rates them 1.00 and 0.90. C1's neutral shrinkage is what moved them out of its top 10. Re-measure after grafting. I haven't run the combination, and C1 reports that leaving the record out failed its current-league 14d crash ratio.

Also scope the cache by past-league data extent, not league names.

### Grafts and rejections

**C1**
- *Graft:* the neutral-rank shrinkage for a record that is structurally missing, with ≥2 leagues required (above). This is the only mechanism in the arena that fixed Emergent and Flux.
- *Graft (second choice):* `haven`. C1, C3 and C4 each derived it independently and each measured a positive IC in every league. Add it as one family.
- *Consider:* `steady` (Sharpe-style mean/sd) as a replacement for `trend`. Its IC is similar to `kept` and it cut crashes when combined.
- *Reject:* nothing major. Its holdout churn and owner losses come from dropping `kept`, so keep production's `kept`.

**C3**
- *Graft:* the worst-third-of-days haven definition. It is the best-documented version (V-primary source, IC positive in all 3–5 leagues through day 60), and C3 measured that the "board-negative days" variant fails on smoothed medians.
- *Graft:* its per-league new-item measurement, as the evidence for how to treat a missing record.
- *Reject:* ranking a missing record at the bottom. Rise of the Abyssal's crash ratio got worse at every horizon because about 60% of that league's board was new. Also reject the hard-coded 98-day no-lookahead assumption; use a calendar cut.

**C4**
- *Graft:* the Kaufman efficiency-ratio `steady` (net move ÷ Σ|moves|) as an alternative to C1's Sharpe version. It needs one fewer statistic and its IC has the same sign in 19 of 19 league-phases.
- *Reject:* `depth` (negative IC in every phase by its own measurement; it pulls owner items up by label-like effect while costing return) and the `_predict` forecast. C1 and C2 each measured that `_predict`'s top 10 crashes 1.2–2× the basket or turns Fate 14d negative, and C3 notes it would double-count the cross-league evidence.

### Threshold note (from C1 and C3, which I agree with)

No scorer, production included, meets crash_ratio ≤ 0.50 on the 14d hold in any past league. The 14d hold is ranked on a board clamped to 7d, and in the opening fortnight the eligible basket itself crashes 40–50% of the time. A per-phase threshold deserves the owner's review. Leave it as is until then.

---

## Candidate 1 — rationale

### Candidate 1: Hold as a store-of-value ranking

#### Design (`scorer.py`)

The score has five signals. Each is ranked against the day's eligible board, and the ranks are averaged with **equal weights**. The dip's weight is k/2, so the Caution dial still works: at k=6 the current-league 7d crash ratio is 0.10, at k=0 it is 0.40. The composite is averaged over the last 3 days, like production, so the list settles. Before league-day 7, `steady` has no value and is left out of the average, as production does.

| Signal | What it measures | Why |
|---|---|---|
| **steady** | Mean daily log change of the smoothed Divine price from league-day 7 up to 3 days ago, divided by its standard deviation | Sharpe's ex-post ratio: "the historic average differential return per unit of historic variability" (verified). It replaces production's `kept` + `trend`. A steady climb scores high. A jumpy rise is divided by its own noise, which answers the owner's "don't chase recent risers" without an ad-hoc penalty. Frog-in-the-Pan (continuous gains persist) points the same way. |
| **dip** | Worst smoothed drop since discovery (production `_signals`) | Unchanged. It drives the Caution dial. |
| **scarcity** | log price in Divine | PoE2: Divine is scarce with "no vendor recipe", Exalted "supply explodes" (verified), and a Lock "effectively a lottery ticket" (verified). Price is the only available supply proxy. The repo measured it as the strongest safety signal in days 1–14. |
| **haven** | The asset's mean daily excess over the board's median move, on the half of the last 14 days when the board did worst | Baur & Lucey's safe haven is an asset that "loses none of its value in case of a market crash" (abstract). Downside risk is priced separately from ordinary beta (Ang, Chen & Xing, abstract). A store of value should hold up on the league's bad days. |
| **record** | Minus the share of 14-day holds, started within ±5 league-days of today in earlier leagues, that lost more than 20% | This uses PoE2's league structure: the same items recur every league, so an item's past behaviour at this league phase is out-of-sample evidence. An item with no record gets the **neutral rank 0.5**: shrunk to the middle, with neither credit nor penalty for missing history. That treatment is what pulls new, thin, just-risen items (Emergent Possibility, Perfect Flux, Aldur's Legacy) back from the extremes. |

#### What PoE2's economy says about stores of value

- **The numeraire inflates, so price in Divine.** Exalted "drops constantly and everyone farms it, so its supply explodes over a league", and "there is no vendor recipe that produces a Divine" (timesaver.gg, verified verbatim). Forbidden Rites went from about 52–65 ex/div to about 503.
- **Rarity is the moat.** A Hinekora's Lock's Divine price "never left the ~1,200–1,345 Divine band" while its Exalted price fell 26% in a week (verified). A Mirror is dearer still. Both are rare world drops, so no one can farm supply.
- **Sinks plus constrained supply.** Omens are "Ritual-only", and "the Omen is consumed" (verified). Every use destroys one, and supply depends on Ritual participation, which thins as the league ages. The Lock is also consumed on commit. In Old School RuneScape an item sink "contributed to the inflation of luxury good prices, without reducing trade volume" (Hogan-Hennessy et al., arXiv abstract). High-end consumables with sinks are the natural stores of value.
- **The league lifecycle repeats.** Every league starts with price discovery (first week), then late-league crafting demand and declining farming. That is why `record` compares like with like: same item, same league phase.

#### Measurements (lab, `lab.py`; 7d hold; IC = daily Spearman vs the forward return from t+2)

`haven` IC was positive in all 5 leagues (+.23/+.26/+.08/+.08/+.36), and still positive at 14d in all 5. `record` IC was positive in all 3 leagues that have it. `steady`'s IC was similar to `kept`'s, but it cut top-10 crashes when combined: the combo without `record` had Fate/Runes 7d crash ratios of 0.61/0.67, against production's 0.84/0.85.

#### Rejected

- **Low volatility.** IC negative in 5/5 leagues (−.13 to −.19). Top-10 crash ratio ≥0.94 in 4/5.
- **Explicit anti-jump penalty.** IC negative in 5/5, top-10 crash ratio 1.13–4.25. It rewards things that just fell.
- **Downside beta.** Weak, and the sign flips in the current league (−.12).
- **Traded value as a signal.** IC negative in 5/5.
- **`_predict` forecast (7/14d) and past-league 30-day retention.** Positive IC, but their top 10s crash 1.2–2× the basket in the current league. `record` measures the thing Hold is for (crashes), not return.
- **Haven variants** (bottom-third or board-negative days). Not consistently better; I kept the first definition.
- **Leaving `record` out when missing** (production's rule). This made the current league's 14d crash ratio 0.527, a FAIL. It is a real alternative, but neutral-rank shrinkage is the principled treatment for data that is missing structurally rather than temporally.
- **Weights.** None are tuned. With five leagues, tuned weights would be fitted to noise (DeMiguel et al.; Dawes).

**Overfitting disclosure:** I screened about 12 signal combinations in the lab on all five leagues, holdout included. The weights are fixed, but the *choice of signals* saw the holdout, so treat the holdout below as optimistic.

#### Smoke test, Forbidden Rites (`smoke.txt`): **PASS, all horizons (exit 0)**

| Hz | vs_board | beat | kept | crash_ratio | dd | churn | owner | chase |
|---|---|---|---|---|---|---|---|---|
| 24h | +2.0 | 67% | 89% | 0.42 | 0.0 | 15% | 100% | 1% |
| 3d | +4.8 | 88% | 100% | 0.11 | 0.0 | 15% | 100% | 2% |
| 7d | +8.1 | 92% | 100% | 0.30 | −1.3 | 15% | 100% | 3% |
| 14d | +0.3 | 60% | 100% | 0.35 | −2.3 | 15% | 100% | 3% |

#### Holdout vs `--scorer production` (production → candidate)

| League | Hz | vs_board | crash_ratio | churn | owner | chase |
|---|---|---|---|---|---|---|
| Dawn of the Hunt | 24h | +3.3 → +3.3 | 0.94 → 0.94 | 26 → 26% | 75 → 75% | 6 → 8% |
| | 3d | +14.0 → +13.4 | 0.84 → 0.91 | 26 → 26% | 75 → 75% | 4 → 6% |
| | 7d | +21.8 → +19.9 | 0.86 → 0.92 | 26 → 26% | 75 → 75% | 0 → 0% |
| | 14d | +29.2 → +28.6 | 1.11 → 1.18 | 26 → 26% | 75 → 75% | 0 → 0% |
| Rise of the Abyssal | 24h | +2.3 → +2.6 | 0.56 → 0.47 | 7 → 10% | 100 → 100% | 5 → 6% |
| | 3d | +7.4 → +7.8 | 0.48 → 0.48 | 7 → 10% | 100 → 100% | 5 → 6% |
| | 7d | +13.8 → +13.8 | 0.63 → 0.55 | 7 → 10% | 100 → 100% | 4 → 4% |
| | 14d | +22.5 → +20.1 | 0.66 → 0.70 | 7 → 10% | 100 → 100% | 4 → 4% |
| Fate of the Vaal | 24h | +0.8 → +0.9 | 0.63 → 0.45 | 7 → 13% | 100 → 100% | 8 → 8% |
| | 3d | +2.7 → +2.9 | 0.62 → 0.39 | 7 → 13% | 100 → 100% | 7 → 11% |
| | 7d | +2.6 → +5.1 | 0.84 → 0.49 | 7 → 13% | 100 → 100% | 7 → 9% |
| | 14d | +3.0 → +12.4 | 1.22 → 0.80 | 7 → 13% | 100 → 100% | 7 → 9% |
| Runes of Aldur | 24h | +0.5 → +0.9 | 0.61 → 0.41 | 9 → 10% | 84 → 77% | 6 → 8% |
| | 3d | +1.5 → +3.2 | 0.74 → 0.45 | 9 → 10% | 84 → 77% | 7 → 10% |
| | 7d | +2.6 → +4.2 | 0.85 → 0.57 | 9 → 10% | 84 → 77% | 7 → 10% |
| | 14d | +5.5 → +5.7 | 0.98 → 0.83 | 9 → 10% | 84 → 77% | 7 → 10% |
| Forbidden Rites (current) | 24h | +1.6 → +2.0 | 0.00 → 0.42 | 18 → 15% | 81 → 100% | 3 → 1% |
| | 3d | +5.5 → +4.8 | 0.00 → 0.11 | 18 → 15% | 81 → 100% | 3 → 2% |
| | 7d | +12.0 → +8.1 | 0.10 → 0.30 | 18 → 15% | 81 → 100% | 1 → 3% |
| | 14d | +11.8 → +0.3 | 0.35 → 0.35 | 18 → 15% | 81 → 100% | 1 → 3% |

**Better (16 past cells):** vs_board in 10 (4 worse: Dawn 3d/7d/14d, Rise 14d). Crash ratio in 10 (4 worse, same cells). Fate 14d goes from +3.0 to +12.4 points, with crash ratio 1.22 → 0.80. Three past cells meet every threshold, against production's one.

**Worse:**
- Churn is higher in 12 of 16 past cells, peaking at 13% (limit 30%).
- Chase is up 1–4 points, peaking at 11% (limit 20%).
- Owner coverage drops in Runes of Aldur, from 84% to 77%.
- In the current league, returns are lower at 3d/7d/14d. The 14d cell (+11.8 → +0.3) rests on only 5 graded days.
- Current-league crash ratio is higher at 24h/3d/7d, on 0–3% absolute crash rates.
- Dawn of the Hunt has no `record`, only 8 graded days, and is slightly worse.

**Threshold note:** no production or candidate cell with 14d holds passes crash_ratio ≤ 0.50 in any past league. 14d holds are ranked on a 7d board (`MAX_HORIZON_DAYS`), so that threshold may be testing the clamp, not the ranking.

#### Day 24, 7d, top 20 (Forbidden Rites)

1 Aldur's Legacy · 2 Uhtred's Exodus · 3 Raven-Touched Shard · 4 Uul-Netol's Embrace · 5 Her Declaration · 6 Garukhan's Resolve · 7 Hinekora's Lock · 8 Seraph's Heart · 9 Uncut Spirit Gem (L15) · 10 Uncut Spirit Gem (L8) · 11 Omen of Light · 12 Emergent Possibility · 13 Omen of Dextral Annulment · 14 Rigwald's Ferocity · 15 Faded Crisis Fragment · 16 Vaal Armourer's Infuser · 17 Preserved Cranium · 18 Vaal Cultivation Orb · 19 Mirror of Kalandra · 20 Omen of Bartering

Compared with production:
- Perfect Flux (+73%/wk) leaves the top 20.
- Emergent Possibility drops from #4 to #12.
- Lock moves from #7 to #7, Omen of Light from #20 to #11, Dextral Annulment from #18 to #13.

**Only partly fixed:** Uhtred's Exodus (+56%, −30% dip, thin) is still #2, Uncut Spirit Gem L8 (+108%) is #10, and Mirror is still #19. Blue-chip omens are mid-board, not top.

## Candidate 1 — sources

### Sources: candidate 1

Status legend:
- **V-primary**: I fetched the primary text myself (curl + grep of the page or PDF) and matched the quote verbatim.
- **V-abstract**: the publisher or repository abstract, relayed by WebFetch's summariser or by search. Not checked character by character.
- **secondary**: another site's description of the source.
- **not verified**: the page could not be read (403 or bot wall).

#### Academic

| # | Citation | URL / DOI | Used for | Status |
|---|---|---|---|---|
| 1 | Sharpe, W. F. (1994). "The Sharpe Ratio." *Journal of Portfolio Management* 21(1), 49–58. | doi:10.3905/jpm.1994.409501 · https://web.stanford.edu/~wfsharpe/art/sr/sr.htm | `steady` = mean ÷ std of daily changes. Quote: "the ratio indicates the historic average differential return per unit of historic variability of the differential return." | **V-primary** (the author's reprint on stanford.edu) |
| 2 | Baur, D. G. & Lucey, B. M. (2010). "Is Gold a Hedge or a Safe Haven? An Analysis of Stocks, Bonds and Gold." *Financial Review* 45(2), 217–229. | doi:10.1111/j.1540-6288.2010.00244.x · https://ideas.repec.org/p/iis/dispap/iiisdp198.html | `haven`. A hedge is "a security that does not co-move with stocks or bonds on average"; a safe haven is "a security that loses none of its value in case of a market crash". The safe-haven effect is short-lived (about 15 trading days), which fits a 14-day window. | V-abstract (RePEc; SSRN returned 403) |
| 3 | Ang, A., Chen, J. & Xing, Y. (2006). "Downside Risk." *Review of Financial Studies* 19(4), 1191–1239. | https://academic.oup.com/rfs/article-abstract/19/4/1191/1580531 · NBER w11824 https://www.nber.org/papers/w11824 | Downside co-movement is a distinct risk from ordinary beta. Supports measuring behaviour on the board's bad days. | V-abstract (search relay). NBER PDF downloaded but not text-extractable here. |
| 4 | Da, Z., Gurun, U. G. & Warachka, M. (2014). "Frog in the Pan: Continuous Information and Momentum." *RFS* 27(7), 2171–2218. | doi:10.1093/rfs/hhu003 · https://academicweb.nd.edu/~zda/Frog.pdf | Smooth gains persist and jumpy gains don't, which is the case for dividing by noise (`steady`) rather than rewarding the level of the gain. | V-primary per `docs/hold-research.md`. Not re-fetched by me. |
| 5 | Hogan-Hennessy, S., Xenopoulos, P. & Silva, C. (2022). "Market Interventions in a Large-Scale Virtual Economy." arXiv:2210.07970. | https://arxiv.org/abs/2210.07970 | Game-economy evidence that an item sink "contributed to the inflation of luxury good prices, without reducing trade volume" (Old School RuneScape). Supports treating consumed high-end items (omens, Locks) as stores of value. | V-abstract (arXiv abstract page) |
| 6 | DeMiguel, V., Garlappi, L. & Uppal, R. (2009). "Optimal Versus Naive Diversification." *RFS* 22(5), 1915–1953. | doi:10.1093/rfs/hhm075 | Equal weights over tuned weights with few samples | V-abstract per `docs/hold-research.md` |
| 7 | Dawes, R. M. (1979). "The robust beauty of improper linear models in decision making." *American Psychologist* 34(7), 571–582. | doi:10.1037/0003-066X.34.7.571 | Unit weights | V-abstract per `docs/hold-research.md` |
| 8 | Lehdonvirta, V. & Castronova, E. (2014). *Virtual Economies: Design and Analysis.* MIT Press. | https://mitpress.mit.edu/9780262535069/virtual-economies/ | Background framing of artificial scarcity in game economies. No claim in the design rests on it. | secondary (publisher blurb only) |

#### PoE2 economy

| # | Source | URL | Used for | Status |
|---|---|---|---|---|
| 9 | timesaver.gg, "PoE2 Divine Orb Price & Exalted Exchange Rate (Forbidden Rites 0.5.5)" | https://timesaver.gg/blog/poe2-divine-exalted-exchange-rate-forbidden-rites-0-5-5 | Price in Divine. Quotes: "It drops constantly and everyone farms it, so its supply explodes over a league." / "There is no vendor recipe that produces a Divine, so supply stays tight." / "As weeks pass, the market is drowning in Exalted while Divines stay scarce". Rates: about 52–65 ex/div on Sept 5 and about 503 on Sept 26 (search-relayed). | **V-primary** for the quotes (curl + grep). Rates are search-relayed. Commercial site (sells currency), not peer-reviewed. |
| 10 | timesaver.gg, "PoE2 Hinekora's Lock Price" | https://timesaver.gg/blog/poe2-hinekoras-lock-price-guide | `scarcity`. Quotes: "the rate is so low it's effectively a lottery ticket"; the Divine price "never left the ~1,200–1,345 Divine band" while the Exalted price fell about 26%. The Lock is spent on commit. | **V-primary** (curl + grep); commercial site |
| 11 | timesaver.gg, "PoE2 Omens Guide (0.5)" | https://timesaver.gg/blog/poe2-omens-guide | Omens as a sink with constrained supply. Quotes: "Ritual is the only source of Omens"; "The Omen is consumed; the orb does the work."; "the targeted Omens are worth more than the orbs they modify". | **V-primary** (curl + grep); commercial site |
| 12 | Game8 / Exiled Tools price snapshots of Omen of Dextral Annulment (about 10.6 div) and Lock (about 1,084 div) | https://game8.co/games/Path-of-Exile-2/archives/491750 · https://www.exiledtools.com/dashboard | Sanity check that DB price levels match live trackers | secondary (search snippet) |
| 13 | EZG, "Currency Redemption System is Facing a Crash and Inflation in PoE2 0.5", and Steam discussion threads | https://www.ezg.com/blog/poe-2-0-5-currency-redemption-system-is-facing-inflation · https://steamcommunity.com/app/2694490/discussions/ | Community claims of no Divine sink and RMT. **Not used in the design.** | not verified (403). Search snippet only. |
| 14 | poe2wiki, "Omen" | https://www.poe2wiki.net/wiki/Omen | Intended primary check of omen mechanics | not verified (bot wall). Timesaver quotes the wiki: Omens "enable meta Crafting…" |

#### Repo sources (measurements and definitions reused)

- `docs/hold-research.md` and `docs/research/hold-research-recovered.md`. These hold the prior measurements: price level is the best safety signal in days 1–14, retention since day 7 is the best inflation-resistance signal, and low-vol runs backwards. They also give the verification status of sources 4, 6 and 7.
- `backend/app/holdscore.py`: `_signals` (dip, price), `_smooth`, `_nearest`, `_pct_ranks`, and the constants `DISCOVERY_DAY`, `SKIP_DAYS`, `SETTLE_DAYS`, `PRED_WINDOW`, `MIN_PRED_LEAGUES`, `CAUTION_K`.
- `ops/hold-backtest.py`: every smoke-test and holdout number (`smoke.txt`, `all.txt`, `all.json`, `baseline.txt`, `baseline.json`).
- Signal lab (mine): `lab.py` + `lab_scorer.py` for per-signal IC and top-10 crash ratios, `peek.py` for per-item signal ranks, and `crashes.py` for which picks crashed.

---

## Candidate 2 — rationale

### Candidate 2: Hold ranked by each item's crash record in earlier leagues

#### Design
`scorer.py` keeps production's frame: signals are ranked on the day's eligible board, averaged with equal weights, and settled over 3 days. It changes two things.

1. **A new signal, `survival`.** It is the share of 14-day holds in earlier leagues, started from league-day 7 on, in which the item lost no more than 20% of its Divine value. Prices are smoothed with production's `_smooth`, and the signal needs at least 20 windows. It does not depend on the league day, because it describes the item, not the league phase. Neither parameter was fitted: 14 days is the longest hold the app offers, and −20% is the smoke test's own `CRASH` line. Results were robust to the line: at 7d, days 1–14, the IC was +.49/+.31 at −20%, +.43/+.32 at −10% and +.39/+.27 at 0%.
2. **This league's momentum counts once, not twice.** `kept` and `trend` both measure this league's climb. Production gives each a full weight, so half its score is recent momentum, and that is the owner's complaint. Here they get ½ each, making one "upswing" signal next to `dip` (Caution dial unchanged), `price` and `survival`.

#### Why this signal: PoE2's economy
- **Divine is the unit of account; Exalted deflates.** "Exalted Orbs are the base currency and the most common map drop, so their supply balloons first" (timesaver.gg). Everything here is priced in Divine.
- **What holds value is scarce and consumed; what bleeds is farmable with limited demand.** Dads of Exile's 0.5 report (36 days, priced in Divine): "Consumable supply outruns finite demand, so they only bleed." Scarce, supply-constrained crafting materials and top orbs gained value. In Old School RuneScape, "the item sink contributed to the inflation of luxury good prices" (Hogan-Hennessy et al. 2022). Omens are destroyed on use, and Mirror and Hinekora's Lock are the rarest drops.
- **An item's economic role is a game-design constant that repeats every league.** Drop source, rarity and how crafting consumes it carry over. No live feed measures sinks or supply, but an item's crash record in earlier leagues is the revealed outcome of that structure. It is the PoE2 equivalent of judging a hedge by its history over many periods. Erb & Harvey (2013) find gold "an unreliable inflation hedge" over practical horizons, so a store of value has to be judged over many periods, not by last week. Baur & Lucey (2010) split hedge from safe haven. `survival` measures a safe-haven-like property: how rarely the item crashed.
- **The league's own momentum stays, but less of it.** On our data, retention since day 7 and trend quality are the only signals still positive after day 15 (repo measurements). Novy-Marx (2012) finds that "recent past performance … [is] less profitable than … intermediate horizon past performance". That supports discounting the last days, which `kept`'s 3-day skip and `trend`'s 2-day skip already do.
- **Equal weights, because four past leagues can't tune weights** (DeMiguel, Garlappi & Uppal 2009; Dawes 1979).

#### Measurements (walk-forward, entry t+2, production universe, daily Spearman IC; [leagues positive/leagues])
| survival | days 1–7 | 8–14 | 15–30 | 31–60 |
|---|---|---|---|---|
| 7d return | +.49 [4/4] | +.31 [4/4] | +.18 [3/4] | −.02 [1/2] |
| 7d forward drawdown (safety) | +.49 [4/4] | +.30 [4/4] | +.17 [4/4] | +.05 [1/2] |
| 14d return | +.48 [4/4] | +.35 [4/4] | +.23 [3/3] | −.03 [1/2] |

For comparison at 7d: `price` +.22/+.14/−.09/−.11, `kept` +.10/+.21/+.21/+.09, `trend` +.20/+.16/+.22/+.14. Like everything else, survival fades after day 30.

#### Rejected alternatives (all graded on all 5 leagues; 9 variants, so read margins with forking paths in mind)
- **Scarcity by units traded** (fewest units per day among assets that clear the value floor). IC was +.31/+.21 in days 1–14, but it puts omens at the bottom: crafting consumes them, so they turn over many units. Owner hedges on the list: Runes of Aldur .68 and the current league .67, against production's .84/.81.
- **Same-phase cross-league 28d forecast** (`_predict`, delta 28). IC +.55 early, but it needs 2 past leagues and put Uncut Spirit Gems at the top. With production's signals, Fate of the Vaal 14d vs_board went from +3.0 to −3.0.
- **Laplace-shrunk survival** ((ok/14+1)/(n/14+2), counting overlapping windows as n/14). It was marginally better on the holdout (Fate of the Vaal 7d +8.3 vs +6.6) but failed the current league's 14d `beat` (2 of 5 graded days). I chose the unshrunk form, so I used the current league to decide between two near-equal forms. That is disclosed here.
- **Five full-weight signals** (kept and trend at 1 each): crash ratio 0.70 vs 0.60 in Runes of Aldur 7d, and owner hedges .95 in the current league.
- **Trend-only upswing:** about the same results. I kept production's `kept` for continuity.
- **Floor retention** (the 2-week minimum vs day 7): IC +.06/+.11, weaker than `kept`.
- **Low volatility:** runs backwards in PoE2, per the repo's own measurements. **Liquidity weight:** it doesn't predict safety before day 30, and Mirror and Lock are illiquid by nature. **Hand-listed omen/category priors:** they break the rule that game data comes from the market pipeline, and `survival` derives the same result from prices.

#### Smoke test, current league (Forbidden Rites): PASS at every horizon (exit 0)
| hz | vs_board | beat | kept | crash_ratio | dd | churn | owner | chase |
|---|---|---|---|---|---|---|---|---|
| 24h | +1.7 | 72% | 100% | 0.00 | 0.0 | 12% | 100% | 2% |
| 3d | +6.1 | 94% | 100% | 0.00 | 0.0 | 12% | 100% | 2% |
| 7d | +11.3 | 100% | 100% | 0.00 | 0.0 | 12% | 100% | 1% |
| 14d | +27.4 | 100% | 100% | 0.00 | −0.1 | 12% | 100% | 1% |

#### Holdout vs `--scorer production` (production → candidate 2)
| League | hz | vs_board | crash_ratio | churn | owner | chase |
|---|---|---|---|---|---|---|
| Dawn of the Hunt | 24h | +3.3 → +3.5 | 0.94 → 0.94 | 0.26 → 0.26 | 0.75 → 0.75 | 0.06 → 0.06 |
| Dawn of the Hunt | 3d | +14.0 → +14.3 | 0.84 → 0.84 | 0.26 → 0.26 | 0.75 → 0.75 | 0.04 → 0.05 |
| Dawn of the Hunt | 7d | +21.8 → +22.6 | 0.86 → 0.86 | 0.26 → 0.26 | 0.75 → 0.75 | 0.00 → 0.01 |
| Dawn of the Hunt | 14d | +29.2 → +30.3 | 1.11 → 1.11 | 0.26 → 0.26 | 0.75 → 0.75 | 0.00 → 0.01 |
| Rise of the Abyssal | 24h | +2.3 → +2.4 | 0.56 → 0.38 | 0.07 → 0.08 | 1.00 → 1.00 | 0.05 → 0.06 |
| Rise of the Abyssal | 3d | +7.4 → +7.1 | 0.48 → 0.44 | 0.07 → 0.08 | 1.00 → 1.00 | 0.05 → 0.06 |
| Rise of the Abyssal | 7d | +13.8 → +12.9 | 0.63 → 0.57 | 0.07 → 0.08 | 1.00 → 1.00 | 0.04 → 0.04 |
| Rise of the Abyssal | 14d | +22.5 → +20.8 | 0.66 → 0.57 | 0.07 → 0.08 | 1.00 → 1.00 | 0.04 → 0.04 |
| Fate of the Vaal | 24h | +0.8 → +0.9 | 0.63 → 0.72 | 0.07 → 0.07 | 1.00 → 1.00 | 0.08 → 0.08 |
| Fate of the Vaal | 3d | +2.7 → +2.6 | 0.62 → 0.53 | 0.07 → 0.07 | 1.00 → 1.00 | 0.07 → 0.09 |
| Fate of the Vaal | 7d | +2.6 → +6.6 | 0.84 → 0.55 | 0.07 → 0.07 | 1.00 → 1.00 | 0.07 → 0.07 |
| Fate of the Vaal | 14d | +3.0 → +17.3 | 1.22 → 0.82 | 0.07 → 0.07 | 1.00 → 1.00 | 0.07 → 0.07 |
| Runes of Aldur | 24h | +0.5 → +0.9 | 0.61 → 0.47 | 0.09 → 0.08 | 0.84 → 1.00 | 0.06 → 0.08 |
| Runes of Aldur | 3d | +1.5 → +2.5 | 0.74 → 0.53 | 0.09 → 0.08 | 0.84 → 1.00 | 0.07 → 0.08 |
| Runes of Aldur | 7d | +2.6 → +3.5 | 0.85 → 0.60 | 0.09 → 0.08 | 0.84 → 1.00 | 0.07 → 0.08 |
| Runes of Aldur | 14d | +5.5 → +4.4 | 0.98 → 0.79 | 0.09 → 0.08 | 0.84 → 1.00 | 0.07 → 0.08 |
| Forbidden Rites (current) | 24h/3d/7d/14d | +1.6/+5.5/+12.0/+11.8 → +1.7/+6.1/+11.3/+27.4 | .00/.00/.10/.35 → .00/.00/.00/.00 | 0.17 → 0.12 | 0.81 → 1.00 | .03/.03/.01/.01 → .02/.02/.01/.01 |

Across the 16 holdout cells, candidate 2 does better / the same / worse than production:
- vs_board: 11 / 0 / 5
- crash_ratio: 11 / 4 / 1
- owner: 4 / 12 / 0
- churn: 4 / 4 / 8 (each loss ≤ +0.01)
- chase: 1 / 3 / 12 (each loss ≤ +0.02)

**Where it is worse:**
- Rise of the Abyssal loses 0.3–1.7 points of vs_board at 3d/7d/14d.
- Fate of the Vaal 24h crash ratio rises from 0.63 to 0.72.
- Runes of Aldur 14d loses 1.1 points of vs_board.
- Chase rises slightly almost everywhere.
- Dawn of the Hunt has no earlier league, so `survival` is absent there and the only change is reweighting.
- Every holdout league still misses some thresholds, as production does: crash_ratio ≤ 0.5 is rarely met in the holdout by any scorer.

**Caveat:** the current-league replay has a small lookahead. Runes of Aldur still runs, so its days after each Forbidden Rites replay day enter `survival`. The holdout leagues don't overlap.

#### Day 24, 7d board, top 20
1. Raven-Touched Shard
2. Emergent Possibility
3. Hinekora's Lock
4. Perfect Flux
5. Uhtred's Exodus
6. Her Declaration
7. Garukhan's Resolve
8. Mirror of Kalandra
9. Aldur's Legacy
10. Uul-Netol's Embrace
11. Seraph's Heart
12. Omen of Dextral Annulment
13. Rigwald's Ferocity
14. Uncut Spirit Gem (L8)
15. Omen of Whittling
16. Omen of Dextral Erasure
17. Omen of Sinistral Erasure
18. Omen of Sinistral Annulment
19. Omen of Light
20. Emergent Vigour

Production has Mirror at #15, Dextral Annulment at #18 and Omen of Light at #20. Here Lock, Mirror and five high-end omens make the top 19, and 4 of the owner's 4 named hedges are in the top 15.

**Not fixed:** Emergent Possibility (#2) and Perfect Flux (#4) stay high. Each has one earlier league, with survival 1.00 and 0.90, and a small smoothed dip. The data calls them safe, and I did not override that by hand.

## Candidate 2 — sources

### Sources: candidate 2

Status key:
- **V-fetch-abstract**: I fetched the publisher or index page and the fetcher returned the abstract verbatim. I did not read the full PDF.
- **V-repo**: verified in the repo's `docs/hold-research.md` with the status shown there. I did not re-verify it.
- **secondary**: a web page or a search-engine summary, not the primary text.
- **not read**: named only.

Researched 2026-09-28. Reading only; nothing was posted.

#### Academic

| # | Citation | URL / DOI | Used for | Status |
|---|---|---|---|---|
| 1 | Erb, C. B. & Harvey, C. R. (2013). "The Golden Dilemma." *Financial Analysts Journal* 69(4). NBER WP 18706 | https://www.nber.org/papers/w18706 · doi:10.2469/faj.v69.n4.1 | A store of value is judged over many periods: "Over practical investment horizons, gold is an unreliable inflation hedge." | V-fetch-abstract (NBER page) |
| 2 | Baur, D. G. & Lucey, B. M. (2010). "Is Gold a Hedge or a Safe Haven? An Analysis of Stocks, Bonds and Gold." *Financial Review* 45(2) 217–229 | doi:10.1111/j.1540-6288.2010.00244.x | Hedge (on average) vs safe haven (under stress). `survival` measures the crash-avoidance property | secondary (search summary of the definitions; paywalled) |
| 3 | Hogan-Hennessy, S., Xenopoulos, P. & Silva, C. (2022). "Market Interventions in a Large-Scale Virtual Economy." arXiv:2210.07970 | https://arxiv.org/abs/2210.07970 | Sinks raise the prices of consumed luxury items in a game economy (OSRS): "the item sink contributed to the inflation of luxury good prices, without reducing trade volume" | V-fetch-abstract (arXiv page) |
| 4 | Novy-Marx, R. (2012). "Is momentum really momentum?" *Journal of Financial Economics* 103(3) 429–453 | doi:10.1016/j.jfineco.2011.05.003 · https://econpapers.repec.org/RePEc:eee:jfinec:v:103:y:2012:i:3:p:429-453 | Discount the most recent rise: "Strategies based on recent past performance generate positive returns but are less profitable than those based on intermediate horizon past performance" | V-fetch-abstract (EconPapers) |
| 5 | Daniel, K. & Moskowitz, T. J. (2016). "Momentum crashes." *JFE* 122(2) 221–247 | https://www.sciencedirect.com/science/article/pii/S0304405X16301490 · https://www.nber.org/papers/w20439 (DOI not confirmed) | Background: momentum has "infrequent and persistent strings of negative returns", one reason not to let momentum dominate a safety list | secondary (abstract relayed by search) |
| 6 | Lehdonvirta, V. & Castronova, E. (2014). *Virtual Economies: Design and Analysis.* MIT Press | https://mitpress.mit.edu/9780262535069/virtual-economies/ | Faucet/sink framing and mudflation (item devaluation over a game's life) | not read (catalog page and secondary descriptions only) |
| 7 | DeMiguel, V., Garlappi, L. & Uppal, R. (2009). "Optimal Versus Naive Diversification." *RFS* 22(5) 1915–1953 | doi:10.1093/rfs/hhm075 | Equal weights with few samples | V-repo (V-abstract) |
| 8 | Dawes, R. M. (1979). "The robust beauty of improper linear models in decision making." *American Psychologist* 34(7) 571–582 | doi:10.1037/0003-066X.34.7.571 | Unit weights | V-repo (V-abstract) |
| 9 | Da, Z., Gurun, U. & Warachka, M. (2014). "Frog in the Pan." *RFS* 27(7) 2171–2218 | doi:10.1093/rfs/hhu003 | Smooth gains persist, which supports production's `trend` (slope × R²) over endpoint returns | V-repo (V-primary) |
| 10 | Moskowitz, Ooi & Pedersen (2012); Clenow (2015); Ritter (1991); Frazzini & Pedersen (2014) | see docs/hold-research.md | Background for production's `kept`/`trend`/discovery-day choices, inherited unchanged | V-repo (as listed there) |

#### PoE2 economy (community, not peer-reviewed)

| # | Citation | URL | Used for | Status |
|---|---|---|---|---|
| 11 | Dads of Exile, "PoE 2 0.5 economy report: what held value (and what crashed)", 2026-07-09 | https://dadsofexile.com/economy-report | "Consumable supply outruns finite demand, so they only bleed." Scarce, supply-constrained crafting materials and top orbs gained value; Exalted lost ~87% vs Divine over 36 days | secondary (page fetched; the quotes are as the fetcher returned them. The method is the author's own, not audited) |
| 12 | Vance, M., "Is the PoE2 Economy Cooked in 0.5.5? What Currency Is Actually Worth Farming in Maps", timesaver.gg, 2026-09-08 | https://timesaver.gg/blog/poe2-economy-cooked-what-currency-worth-farming-maps-0-5-5 | "Exalted Orbs are the base currency and the most common map drop, so their supply balloons first"; "A Divine getting more expensive in Exalted is not inflation of the Divine — it is deflation of the Exalted." | secondary (page fetched) |
| 13 | timesaver.gg, PoE2 Divine/Exalted rate, Forbidden Rites 0.5.5 | https://timesaver.gg/blog/poe2-divine-exalted-exchange-rate-forbidden-rites-0-5-5 | Divine as numeraire (already in the repo) | V-repo (secondary) |
| 14 | timesaver.gg, Hinekora's Lock and Mirror of Kalandra price guides | https://timesaver.gg/blog/poe2-hinekoras-lock-price-guide · https://timesaver.gg/blog/poe2-mirror-of-kalandra-price-guide | Lock and Mirror are the two most expensive currencies (≈1,325 div; low-to-mid thousands of div) | secondary (search summary) |
| 15 | Switchblade Gaming, "PoE2 Economy Guide 2026: Week 1 vs Week 4 Price Curves", 2026-08-04 | https://www.switchbladegaming.com/path-of-exile-2/economy-guide-4/ | **Rejected as evidence.** It quotes Divine in Chaos and says Divine falls, which contradicts our DB (Divine ≈28 → ≈500 ex) and sources 11–12 | secondary, low trust |
| 16 | poe2scout / poe.ninja / Out of Games omen pages | https://poe2scout.com · https://poe.ninja/poe2/economy/vaal/omens · https://outof.games/realms/poe2/economy/omens/ | Omens come from Ritual and are consumed on use, so crafting is their sink | secondary (search summary) |

#### Measurements behind every choice (mine, reproducible)
Everything is in this directory:
- `ic.py` + `signals.py`: the IC study (`python3 ic.py 7 ret|dd`, `python3 ic.py 14 ret`).
- `scorer_experiments.py`: every variant graded (switched by the `C2_VARIANT` env var).
- `v_*.json` / `v_*.txt`: the variant backtests. `v_shrunk` is the Laplace variant. The run of the first variant ("final0": scarcity + 28d record) was overwritten; its numbers are quoted in RATIONALE from the run log.
- `baseline.json`: production.
- `all.json` / `all.txt`: the final scorer on every league.
- `smoke_current.txt`: the current-league smoke test.
- `day24_7d.txt`: the day-24 7d board.
- `cmp.py`: prints the comparison tables.

---

## Candidate 3 — rationale

### Candidate 3: a safe-haven board with a cross-league track record

#### Design

Every signal is ranked against the day's eligible board, and the families are averaged with equal weights. Production's eligibility gate, "left out, never 0" rule and 3-day settle are unchanged.

| Family | Signal | Why |
|---|---|---|
| **haven** (new) | Mean smoothed log return *relative to the board's median* over the board's worst third of days since league-day 7 | Baur & Lucey (2010) define a safe haven as an asset "uncorrelated or negatively correlated with another asset or portfolio in times of market stress or turmoil" (verified verbatim, primary PDF). "Resists inflation" in a league means the item holds up on the days everything else slides against Divine. |
| **retain** | Production's `kept` and `trend` at **half weight each** | Both reward a past rise. As one family, the rise counts once. This answers the owner's "too heavily weighting items that have recently gone up". The family structure comes from composite-indicator practice (OECD/JRC Handbook) and is not fitted. |
| **price** | log price in Divine | PoE2's expensive items are supply-throttled: Hinekora's Lock is "a very rare world drop with no targeted farm", and "There is no vendor recipe that produces a Divine" (timesaver.gg). Repo measurement: the top price fifth has the shallowest forward drawdowns in days 1–14, in 5/5 leagues. |
| **track** (new) | The same item's rank for value kept from league-day 7 to 60 in *past* leagues, recency-weighted (`GAMMA`) | Every league re-runs the same drop tables and crafting sinks, so being a store of value is a property of the item. Items with **no record rank bottom** (Ritter 1991: new listings underperform), measured below. |
| **dip** | Production's smoothed dip, weight k/2 | Keeps the Caution dial working. |

Before day 7, only price, track and dip exist. The weights are fixed and equal because five leagues cannot identify fitted weights (DeMiguel et al. 2009; Dawes 1979; Gelman 2006). The track window (7→60) is set a priori as "after discovery, through month two". There is no look-ahead: consecutive leagues start ≥ 98 days apart, so a past league's days ≤ 61 always come before the current league's day 1.

#### Measurements behind the choices

These are walk-forward ICs: daily Spearman correlation of each signal against the forward return from entry at t+2, on the production-eligible board. The bracket counts leagues where the IC was positive; c = crash rate of the signal's top fifth. Script: `c3work/ic.py`.

| 7d hold | d1–7 | d8–14 | d15–30 | d31–60 |
|---|---|---|---|---|
| haven (worst-third) | – | +.34 [5/5] c9% | +.15 [3/3] | +.18 [3/3] |
| track | +.55 [4/4] c10% | +.36 [4/4] c7% | +.14 [2/3] | .00 |
| kept | +.10 c41% | +.22 c16% | +.20 | +.20 |
| price | +.22 c20% | +.15 | −.09 | −.09 |
| traded value ("depth") | −.09 [1/5] c43% | −.07 | −.11 | −.13 |
| −jump | +.02 | −.07 [0/5] | −.02 | +.04 |

On the 14d hold, haven and track are positive in every phase through day 30.

**New items** (no track record), mean log-return gap to the day's median, 7d hold, days 8–14: Rise −17 pts (crash 37% vs 17% for old items); Fate −62 pts (42% vs 17%); Aldur −20 pts (34% vs 25%). New items are worse in days 1–14 in 3/3 leagues, about neutral in days 15–30, and worse after day 60.

#### PoE2's economy: what holds value

- **Faucets vs sinks.** Exalted Orbs "drop constantly and everyone farms it", and Divines have no recipe. Exalted therefore inflates against Divine (FR ~28 → ~500 ex/div). Hold ranks in Divine, so everything is judged against the scarcer unit. Game-economy research finds item sinks push luxury-good prices up (Hogan-Hennessy et al. 2022, OSRS: "the item sink contributed to the inflation of luxury good prices").
- **What appreciates.** Community guides consistently name supply-throttled, crafting-consumed items. Targeted omens are consumed when used, "consumed in high volume by endgame crafters". Annulments "supply never keeps up with endgame crafting demand". Hinekora's Lock demand "increases dramatically" late as players corrupt mirror-tier gear. Mirror and Lock are "the gold standard". These are secondary, unverified sources. What I take from them is the mechanism (rarity + consumption + endgame demand growth), and **track** measures that mechanism directly on our data instead of hand-listing items (per the "game data rides the pipeline" rule).
- **League dynamics.** Each league has a discovery week, new mechanic items are priced by very few traders, player counts decay, and there is an end-of-league liquidation. Given this, kept/haven start at day 7, new items rank bottom on track, and the track window stops at day 60.
- **Liquidity is not safety inside the gate.** Once the board is cut to the top half by traded value, more traded value does *not* mean fewer crashes (depth row above). Emergent Possibility trades ~1M ex/day against Whittling's ~478M, but that difference does not predict its outcome.

#### Considered and rejected

- **Cross-league forecast `_predict` (30d, ±5, days ≤14).** Its IC is strong early (+.55, d1–7), but **track** has the same early skill, works all league and needs no phase alignment. Using both would count the cross-league evidence twice. v1 (with the forecast) got owner 57% on FR.
- **Traded-value "depth" family.** IC positive in only 3 of 18 league×phase cells (7d), and top-fifth crash rates were no better.
- **An explicit anti-jump signal.** IC ≈ 0 and negative in 5/5 leagues at d8–14. `kept`/`trend` already skip the last 2–3 days, and chase stays ≤ 10%.
- **"Haven" on basket-down days (median < 0).** Smoothed medians are mostly exactly 0, so that version fired only after day 30 and its sign flipped. The worst third of days is robust.
- **Full-weight kept + trend (v2n).** Better vs_board (Fate 14d +28.4), but the owner's hedges appear less often (RoA 96% vs 93%, FR 71% vs 100%), and it double-counts the rise the owner objected to. v3 (new items left out rather than bottom-ranked) had a worse Fate crash ratio (14d 1.24 vs 1.03).
- **Tuning weights, settle length or windows to pass thresholds.** Not done: every constant is production's or set a priori.

#### Smoke test, current league (Forbidden Rites): **PASS, exit 0**

| Hz | ret | vs board | beat | kept | crash ×bd | churn | owner | chase |
|---|---|---|---|---|---|---|---|---|
| 24h | +7.5 | +2.7 | 94% | 100% | 0.00 | 17% | 100% | 4% |
| 3d | +23.1 | +9.1 | 100% | 100% | 0.22 | 17% | 100% | 6% |
| 7d | +56.2 | +24.7 | 100% | 100% | 0.00 | 17% | 100% | 3% |
| 14d | +132.5 | +53.5 | 100% | 100% | 0.18 | 17% | 100% | 3% |

Only 12 days are graded at 7d and 5 at 14d, so treat this as a smoke test, not evidence.

#### Holdout vs `--scorer production` (all leagues)

| League | Hz | vs_board | crash_ratio | churn | owner | chase |
|---|---|---|---|---|---|---|
| Dawn (no past league: no track) | 24h/3d/7d/14d | +3.3/+14.0/+21.8/+29.2 → +3.4/+14.2/+22.9/+30.8 | 0.94/0.84/0.86/1.11 → same | 26→27% | 75→75% | 0–6→1–6% |
| Rise | 24h | +2.3 → **+2.0** | 0.56 → **0.66** | 7→**11%** | 100→100% | 5→**8%** |
| Rise | 3d | +7.4 → **+6.7** | 0.48 → **0.65** | 7→**11%** | 100→100% | 5→**7%** |
| Rise | 7d | +13.8 → +14.2 | 0.63 → **0.80** | 7→**11%** | 100→100% | 4→4% |
| Rise | 14d | +22.5 → +24.7 | 0.66 → **0.74** | 7→**11%** | 100→100% | 4→4% |
| Fate | 24h | +0.8 → +1.5 | 0.63 → 0.54 | 7→8% | 100→100% | 8→8% |
| Fate | 3d | +2.7 → +4.9 | 0.62 → 0.53 | 7→8% | 100→100% | 7→**10%** |
| Fate | 7d | +2.6 → +10.5 | 0.84 → 0.57 | 7→8% | 100→100% | 7→8% |
| Fate | 14d | +3.0 → +19.6 | 1.22 → 1.03 | 7→8% | 100→100% | 7→8% |
| Aldur | 24h | +0.5 → +0.6 | 0.61 → 0.61 | 9→10% | 84→93% | 6→7% |
| Aldur | 3d | +1.5 → +2.6 | 0.74 → 0.57 | 9→10% | 84→93% | 7→8% |
| Aldur | 7d | +2.6 → +3.7 | 0.85 → 0.70 | 9→10% | 84→93% | 7→7% |
| Aldur | 14d | +5.5 → **+4.4** | 0.98 → 0.85 | 9→10% | 84→93% | 7→7% |
| Forbidden Rites | 24h/3d/7d/14d | see smoke | 0.00/0.00/0.10/0.35 → 0.00/0.22/0.00/0.18 | 18→17% | 81→100% | 1–3→3–6% |

Across the 16 past-league cells: vs_board is better in 13 and worse in 3; crash ratio is better in 7 and worse in 4, with **Rise of the Abyssal worse at every horizon** (it launched with a new-mechanic board where ~60% of eligible items had no record); owner is better in 4 and worse in 0; **churn is worse in 16/16** (+1 to +4 points, all ≤ 30%); chase is worse in 10 (≤ +3 points). **Past leagues still fail the thresholds, as production does**: crash_ratio ≤ 0.50 is missed almost everywhere, and Aldur fails `kept`/`beat`. I think crash_ratio ≤ 0.50 is unreachable in the opening fortnight, when the eligible basket itself crashes 40–50% of the time. A per-phase threshold would read more honestly. I did not change it.

#### Day 24, 7d, top 20

1 Her Declaration · 2 Aldur's Legacy · 3 Uhtred's Exodus · 4 Emergent Possibility · 5 Seraph's Heart · 6 Raven-Touched Shard · 7 Perfect Flux · 8 **Hinekora's Lock** · 9 Uncut Spirit Gem (L15) · 10 **Omen of Light** · 11 Uul-Netol's Embrace · 12 Emergent Vigour · 13 Preserved Cranium · 14 **Omen of Dextral Annulment** · 15 Uncut Spirit Gem (L8) · 16 Garukhan's Resolve · 17 Uhtred's Saga · 18 Vaal Armourer's Infuser · 19 **Mirror of Kalandra** · 20 Rigwald's Ferocity.

Compared with production, the Lock moves 7→8, Light 20→10, Dextral 18→14 and Mirror 15→19. **Emergent Possibility (#4) and Perfect Flux (#7) remain.** Both have strong past-league records (track 0.90 / 0.78) and the board's best haven readings. The data says they were stores of value before, so this candidate does not fully meet the owner's "omens on top" wish. Whittling sits at #32: its haven is low, because it falls with the board on bad days.

## Candidate 3 — sources

### Sources: candidate 3

Status: **V-primary** means I read the quoted text in the primary document during this session. **V-abstract** means the publisher/SSRN/arXiv abstract page was relayed by search or fetch. **Secondary** means a non-peer-reviewed web page, fetched and summarised by a tool (the quotes are the fetcher's extraction, not a PDF I read). **Repo** means cited as recorded in `docs/hold-research.md` with that doc's status, and not re-verified by me.

#### Academic

| # | Citation | Link | Used for | Status |
|---|---|---|---|---|
| 1 | Baur, D. G. & Lucey, B. M. (2010). "Is Gold a Hedge or a Safe Haven? An Analysis of Stocks, Bonds and Gold." *Financial Review* 45(2), 217–229. | doi:10.1111/j.1540-6288.2010.00244.x · PDF https://brianmlucey.com/wp-content/uploads/2011/05/gold_safehavenorhedge_fr.pdf | The **haven** family. §2.3: "A safe haven is defined as an asset that is uncorrelated or negatively correlated with another asset or portfolio in times of market stress or turmoil." Abstract: "A portfolio analysis further shows that the safe haven property is short-lived." | **V-primary** (text extracted from the PDF's content streams) |
| 2 | Ang, A., Chen, J. & Xing, Y. (2006). "Downside Risk." *Review of Financial Studies* 19(4), 1191–1239. | doi:10.1093/rfs/hhj035 · https://www.nber.org/system/files/working_papers/w11824/w11824.pdf | Background: investors weight co-movement in down markets separately from average beta. This supports judging an asset on the market's bad days. | V-abstract |
| 3 | Erb, C. B. & Harvey, C. R. (2013). "The Golden Dilemma." *Financial Analysts Journal* 69(4), 10–42. | doi:10.2469/faj.v69.n4.1 · https://www.nber.org/papers/w18706 | Caveat: gold is an unreliable inflation hedge over practical horizons. This is why I use a measured, cross-sectional haven rather than an asset-class label. | V-abstract |
| 4 | Ritter, J. R. (1991). "The Long-Run Performance of Initial Public Offerings." *Journal of Finance* 46(1), 3–27. | doi:10.1111/j.1540-6261.1991.tb03743.x | New listings underperform, so items with no track record rank bottom on **track**. | Repo (V-abstract) |
| 5 | Hogan-Hennessy, S., Xenopoulos, P. & Silva, C. (2022). "Market Interventions in a Large-Scale Virtual Economy." arXiv:2210.07970. | https://arxiv.org/abs/2210.07970 | Game-economy evidence (Old School RuneScape): "the item sink contributed to the inflation of luxury good prices, without reducing trade volume". It does not cover PoE. | V-abstract (arXiv page, fetched) |
| 6 | DeMiguel, V., Garlappi, L. & Uppal, R. (2009). "Optimal Versus Naive Diversification." *RFS* 22(5), 1915–1953. | doi:10.1093/rfs/hhm075 | Equal weights, not fitted ones. | Repo (V-abstract) |
| 7 | Dawes, R. M. (1979). "The robust beauty of improper linear models in decision making." *American Psychologist* 34(7), 571–582. | doi:10.1037/0003-066X.34.7.571 | Unit weights. | Repo (V-abstract) |
| 8 | Gelman, A. (2006). "Prior distributions for variance parameters in hierarchical models." *Bayesian Analysis* 1(3), 515–534. | doi:10.1214/06-BA117A | Too few groups (leagues) to identify pooling or weight parameters. | Repo (see docs/research/hold-research-recovered.md §6) |
| 9 | OECD/JRC (2008). *Handbook on Constructing Composite Indicators: Methodology and User Guide.* | https://www.oecd.org/sdd/42495745.pdf | Aggregate within a dimension first, then across dimensions. This is the basis for kept+trend as ONE family at half weight each. | Repo (recovered research §6; not re-read) |
| 10 | Da, Z., Gurun, U. & Warachka, M. (2014). "Frog in the Pan." *RFS* 27(7), 2171–2218. | doi:10.1093/rfs/hhu003 | The `trend` (steady-climb) signal inherited from production. | Repo (V-primary there) |
| 11 | Castronova, E. (2003). "On Virtual Economies." *Game Studies* 3(2). | https://www.gamestudies.org/0302/castronova/ | Read; no statements on sinks or inflation, so **not used**. | Fetched, not relevant |
| 12 | Lehdonvirta, V. & Castronova, E. (2014). *Virtual Economies: Design and Analysis.* MIT Press. | https://www.semanticscholar.org/paper/d9f36e23190ecc981dd422bf25ba776d98e4e774 | Faucet/sink framing (general). | Secondary (search summary only) |

#### PoE2 economy (community, not peer-reviewed)

| # | Source | Link | Used for | Status |
|---|---|---|---|---|
| 13 | timesaver.gg, "PoE2 Divine Orb Price & Exalted Exchange Rate (Forbidden Rites 0.5.5)", 2026-09-05 | https://timesaver.gg/blog/poe2-divine-exalted-exchange-rate-forbidden-rites-0-5-5 | Exalted "drops constantly and everyone farms it"; "There is no vendor recipe that produces a Divine, so supply stays tight". This is why ranking happens in Divine. | Secondary (fetched) |
| 14 | timesaver.gg, "PoE2 Hinekora's Lock Price … (0.5.4)", 2026-07-16 | https://timesaver.gg/blog/poe2-hinekoras-lock-price-guide | "It's a very rare world drop with no targeted farm"; the Lock is "flat in Divine, 'crashing' in Exalted". Supports the **price** family (supply throttle). | Secondary (fetched) |
| 15 | mmojugg, "Mastering Hinekora's Lock in Path of Exile 2" | https://www.mmojugg.com/news/mastering-hinekoras-lock-in-path-of-exile-2.html | Lock demand rises mid-to-late league as players corrupt expensive gear; Mirror and Lock are "the gold standard". | Secondary (search snippet only, not fetched) |
| 16 | timesaver.gg, "PoE2 Orb of Annulment Price/Guide (0.5.4)" | https://timesaver.gg/blog/poe2-orb-of-annulment-price-guide | "supply never keeps up with endgame crafting demand", i.e. a consumption sink. | Secondary (search snippet only) |
| 17 | Switchblade Gaming, "PoE2 Omens Ranked" | https://www.switchbladegaming.com/path-of-exile-2/omens-guide/ | Omens come only from Ritual tribute; the targeted omens (Erasure, Annulment, Whittling, Light, Chance) are the valuable ones. | Secondary (search snippet only) |
| 18 | timesaver.gg, "Omen of Whittling Guide"; fextralife wiki "Omen of Whittling" | https://timesaver.gg/blog/poe2-omen-of-whittling-guide · https://pathofexile2.wiki.fextralife.com/Omen_of_Whittling | Omens are consumed when the action happens and are "consumed in high volume by endgame crafters", i.e. a steady sink. | Secondary (search snippet only) |
| 19 | companionlink / poecurrency / EZG inflation articles | https://www.companionlink.com/blog/2025/12/path-of-exile-2-currency-changes-in-patch-0-3-0/ · https://www.poecurrency.com/news/poe-2-patch-0-4-0-how-to-deal-with-inflation-crisis-for-average-players | Divine creation outpaces sinks; Divines are hoarded as money rather than used. | Secondary (search snippet only) |

#### Measurements (this candidate; reproducible)

| # | What | Where |
|---|---|---|
| M1 | Walk-forward IC and top-fifth crash rate by phase for haven / track / kept / trend / price / dip / ulcer / depth / −jump / `_predict` 14d & 30d, at 3d / 7d / 14d holds | `scratchpad/c3work/ic.py` + `feats.py` |
| M2 | New-vs-old item forward returns and crash rates by phase and league | `scratchpad/c3work/newitem.py` |
| M3 | Backtests of variants v1 (with `_predict`), v2, v2n, v3 and v3n (= final) against production | `scratchpad/c3work/v*.txt`, `v*.json`, `cmp.py` |
| M4 | Final smoke test, holdout and day-24 board | `candidate-3/smoke.txt`, `all.txt`, `all.json`, `baseline.json`, `day24.txt` |
| M5 | Repo measurement: top price fifth has shallower forward drawdowns days 1–14 in 5/5 leagues; thin-asset move rates | `docs/hold-research.md` "Measurements, 2026-09-28"; `docs/research/hold-research-recovered.md` §4 |

---

## Candidate 4 — rationale

### Candidate 4: Hold as safe haven + steady climb + parkable

#### Design

Seven signals. Each one is ranked against the day's eligible board, and the ranks are averaged with fixed weights. A signal an asset can't be measured on yet is left out of its average. The score is the mean over the last 3 boards, the same settling production uses. Stdlib only; it reuses `holdscore._signals`, `_smooth`, `_pct_ranks` and `_predict`.

| Signal | Weight | What it is | Why |
|---|---|---|---|
| kept | 1 | log change from league-day 7 to t−3 (production) | IC +0.10/+0.22/+0.25/+0.20/+0.23 by phase at 7d, the sign agreeing in every league |
| dip | k/2 (Caution dial) | worst smoothed drop since discovery (production) | IC +0.21/+0.28 in days 1–14; top-fifth crash rate 11% vs 22% on days 8–14 |
| **steady** (new) | 1 | Kaufman efficiency ratio of the smoothed path since discovery: net log move ÷ Σ\|daily log moves\| | "continuous" gains persist and jumps don't (Da, Gurun & Warachka 2014). IC +0.25/+0.26/+0.16/+0.12/+0.23, same sign in 19 of 19 league-phases. It replaces production's slope×R² (`trend`), which ranks a jumpy riser like Emergent Possibility #1 |
| **haven** (new) | 1 | mean daily excess log return over the board median, on the board's worst third of days since discovery | Baur & Lucey (2010): a safe haven holds up when the market falls. IC +0.29/+0.14/+0.18/+0.23 from day 8 on, same sign in 14 of 14. It is the only signal still clearly positive after league-day 60 |
| forecast | 1 | `holdscore._predict` (±5-day analog), league-days ≤ 14 and only with ≥ 2 past leagues | IC +0.48 on days 1–7 (3 of 3 leagues), top-fifth crash rate 12% vs 36%. Production computes it but doesn't rank with it |
| price | ½ | log price in Divine | Scarcity. The most expensive fifth crashes half as often in days 1–7 (20% vs 40%) |
| depth | ½ | log median traded value (ex/day) | Saleability. Menger (1892): money emerges from the most saleable goods. The owner's hedges are the deepest markets (Mirror #2, Omen of Whittling #3, Omen of Light #4, Hinekora's Lock #5 by traded value on day 24) |

IC = daily Spearman(signal, 7d forward return in Divine, entry t+2), averaged per league. Phases are days 1–7 / 8–14 / 15–30 / 31–60 / 61+. The harness (`ic.py`) uses the backtest's own eligible universe and `path()`.

Price and depth are two halves of one idea, "a thing people park wealth in", so they share one unit of weight. Every weight is 1 or a structural ½, never fitted (Dawes 1979; DeMiguel et al. 2009). Four past leagues can't identify fitted weights (Gelman 2006, J < 5).

#### PoE2's economy, and what it says about a store of value

- **Every currency is a consumable.** In PoE, "every single item in the game has some intrinsic functionality and value", and prices follow "the availability of each single resource" (Shalyt 2017). A store of value is therefore something with throttled supply and steady consumption, not a pure token.
- **Omens have one throttled source and a bulk sink.** Ritual is "the only source of Omens" (timesaver.gg, 2026-07). Omen of Light and Omen of Whittling "clear more exchange volume than any other omen … because they are consumed in bulk by endgame Desecration crafting" (Dads of Exile, league-day 14). The data agrees: both are top-4 by traded value. This is why depth is in the score. In this data it is how the market tells a bulk-consumed crafting omen apart from a thin speculative artifact.
- **Mirror and Hinekora's Lock** are lottery drops with "no farm strategy" (timesaver.gg). Their Divine price is flat when Exalted moves. The article's example is Divine sliding ~27% against Exalted while the Lock "never left the ~1,200–1,345 Divine band". Pricing in Divine is right.
- **League arc.** Week 1 is price discovery: prices are "40–60% inflated versus Week 2 equilibrium" and Divine carries a 20–25% week-1 premium (community guides, secondary). That backs production's DISCOVERY_DAY = 7 and the path window starting there.
- **Game-economy research:** an item sink in Old School RuneScape "contributed to the inflation of luxury good prices, without reducing trade volume" (Hogan-Hennessy et al. 2022). Sinks prop up luxury goods, which is consistent with omens and Mirror-tier items keeping value.

#### Considered and rejected (all measured)

- **depth at full weight**: owner 100% in the current league, but holdout return fell (Fate 14d +3.0 → −0.1). Depth's own IC is negative in every phase (−0.09 to −0.18), an illiquidity premium like Amihud's (2002). Half weight is the compromise.
- **No depth, price at full weight**: best holdout returns, but the current league fails (14d crash ratio 0.53, owner 74–86%).
- **Geometric mean of ranks** (OECD-style non-compensatory aggregation): Dawn of the Hunt went negative (14d −9.7).
- **Keeping trend beside steady**: no gain, and owner fell to 58% in Runes of Aldur.
- **Skipping the last 3 days in steady and haven** (the momentum skip period): worse holdout, and Emergent Possibility stayed #5.
- **Anti-jump penalty** (`calm`): IC negative in days 8–30 in most leagues, so jumps continue over the next week. Penalising them costs return. The grader's `chase` stays low without it.
- **Frog-in-the-pan share of up-days on raw closes**: good early (+0.26), but flips sign on days 31–60. The efficiency ratio is steadier.
- **A category prior for omens**: rejected as hand-tuning a label. Depth reaches the same assets through measured traded value.

About 14 weight sets were tried. That is itself a multiple-testing risk, so the holdout below is the real test.

#### Smoke test, current league (Forbidden Rites): exit 0, PASS every horizon

| hz | vs_board prod → c4 | crash_ratio | churn | owner | chase |
|---|---|---|---|---|---|
| 24h | +1.6 → +1.8 | 0.00 → 0.00 | 18 → 18% | 81 → 90% | 3 → 3% |
| 3d | +5.5 → +6.4 | 0.00 → 0.00 | 18 → 20% | 81 → 90% | 3 → 4% |
| 7d | +12.0 → +15.7 | 0.10 → 0.10 | 18 → 20% | 81 → 90% | 1 → 3% |
| 14d | +11.8 → +22.4 | 0.35 → 0.18 | 18 → 20% | 81 → 90% | 1 → 3% |

#### Holdout vs `--scorer production` (all 5 leagues)

| league | hz | vs_board | crash_ratio | churn % | owner % | chase % |
|---|---|---|---|---|---|---|
| Dawn of the Hunt | 24h | +3.3 → +3.0 | 0.94 → 0.70 | 26 → 17 | 75 → 75 | 6 → 5 |
| Dawn of the Hunt | 3d | +14.0 → +12.9 | 0.84 → 0.91 | 26 → 17 | 75 → 75 | 4 → 5 |
| Dawn of the Hunt | 7d | +21.8 → +19.9 | 0.86 → 0.96 | 26 → 17 | 75 → 75 | 0 → 0 |
| Dawn of the Hunt | 14d | +29.2 → +26.6 | 1.11 → 1.16 | 26 → 17 | 75 → 75 | 0 → 0 |
| Rise of the Abyssal | 24h | +2.3 → +2.2 | 0.56 → 0.47 | 7 → 9 | 100 → 97 | 5 → 6 |
| Rise of the Abyssal | 3d | +7.4 → +7.0 | 0.48 → 0.63 | 7 → 9 | 100 → 97 | 5 → 5 |
| Rise of the Abyssal | 7d | +13.8 → +12.2 | 0.63 → 0.66 | 7 → 9 | 100 → 97 | 4 → 4 |
| Rise of the Abyssal | 14d | +22.5 → +18.5 | 0.66 → 0.67 | 7 → 9 | 100 → 97 | 4 → 4 |
| Fate of the Vaal | 24h | +0.8 → +0.7 | 0.63 → 0.45 | 7 → 9 | 100 → 100 | 8 → 10 |
| Fate of the Vaal | 3d | +2.7 → +2.5 | 0.62 → 0.65 | 7 → 9 | 100 → 100 | 7 → 10 |
| Fate of the Vaal | 7d | +2.6 → +5.9 | 0.84 → 0.76 | 7 → 9 | 100 → 100 | 7 → 8 |
| Fate of the Vaal | 14d | +3.0 → +6.3 | 1.22 → 0.98 | 7 → 9 | 100 → 100 | 7 → 8 |
| Runes of Aldur | 24h | +0.5 → +1.1 | 0.61 → 0.27 | 9 → 10 | 84 → 72 | 6 → 8 |
| Runes of Aldur | 3d | +1.5 → +2.8 | 0.74 → 0.60 | 9 → 10 | 84 → 72 | 7 → 11 |
| Runes of Aldur | 7d | +2.6 → +4.2 | 0.85 → 0.86 | 9 → 9 | 84 → 72 | 7 → 9 |
| Runes of Aldur | 14d | +5.5 → +6.4 | 0.98 → 0.98 | 9 → 9 | 84 → 72 | 7 → 9 |
| Forbidden Rites | all | see above | | | | |

**Where it is worse, honestly.** Across the 16 past-league cells, c4 beats production on vs_board in 6 and loses in 10. All 8 losses in Dawn and Rise are small (−0.1 to −4.0 points); it wins every Fate 7d/14d and Runes cell. Crash ratio: better in 7, worse in 9. Churn: worse in 12, by 1–2 points, though Dawn improves 26 → 17. Owner: worse in 8 (Runes 84 → 72, Rise 100 → 97), tied in 8. Chase: worse in 11, by 1–4 points, all under the 20% threshold. Threshold passes: 5 of 20 cells vs production's 4 (Fate 24h newly passes). No scorer passes the older leagues' crash_ratio or kept thresholds. In early days the eligible basket is the young league itself, so I read those as limits of the data, not of the score.

#### Day 24, 7d top 20 (c4)

1 Aldur's Legacy · 2 Uhtred's Exodus · 3 Her Declaration · 4 Raven-Touched Shard · 5 Emergent Possibility · 6 Seraph's Heart · 7 Perfect Flux · 8 Omen of Light · 9 Preserved Cranium · 10 Perfect Exalted Orb · 11 Uncut Spirit Gem (L15) · 12 Hinekora's Lock · 13 Uul-Netol's Embrace · 14 Omen of Chaotic Rarity · 15 Omen of Dextral Annulment · 16 Garukhan's Resolve · 17 Vaal Armourer's Infuser · 18 Faded Crisis Fragment · 19 Rigwald's Ferocity · 20 Greater Chaos Orb

Against production: Omen of Light #20 → #8, Omen of Dextral Annulment #18 → #15. Hinekora's Lock falls #7 → #12, and Mirror falls from #15 to outside the top 20 (Mirror's haven rank is 75/92: in Divine it fell more than the board on stress days). **The live complaint is not fixed.** Emergent Possibility (#4 → #5) and Perfect Flux (#5 → #7) stay near the top. On smoothed prices, Emergent's climb since day 7 really is steady (efficiency rank 5) and it held up on stress days (haven #1). Only its thin market (depth rank 79) counts against it. To demote it further you would need depth at full weight, which costs holdout return (see Rejected), or an explicit thinness gate.

## Candidate 4 — sources

### Sources — candidate 4

Status: **V-primary** = quote read on the primary page/PDF this session · **V-abstract** = publisher/repository
abstract read this session · **V-search** = abstract/claims seen only through a search-engine summary ·
**repo-verified** = marked V-primary in `docs/hold-research.md` (2026-09-28), not re-read by me ·
**secondary** = non-peer-reviewed web page, read this session.

#### Academic

| # | Citation | URL / DOI | Used for | Status |
|---|---|---|---|---|
| 1 | Baur, D. G. & Lucey, B. M. (2010). "Is Gold a Hedge or a Safe Haven? An Analysis of Stocks, Bonds and Gold." *Financial Review* 45(2), 217–229. | doi:10.1111/j.1540-6288.2010.00244.x · https://researchonline.gcu.ac.uk/en/publications/is-gold-a-hedge-or-a-safe-haven-an-analysis-of-stocks-bonds-and-g/ | `haven` signal. Verbatim abstract: "…a safe haven, defined as a security that is uncorrelated with stocks and bonds in a market crash?" and "the safe haven property is short-lived." | V-abstract (GCU repository page; SSRN 952289 returned 403) |
| 2 | Da, Z., Gurun, U. G. & Warachka, M. (2014). "Frog in the Pan: Continuous Information and Momentum." *RFS* 27(7), 2171–2218. | doi:10.1093/rfs/hhu003 · https://academicweb.nd.edu/~zda/Frog.pdf | `steady`: continuous gains persist, discrete ones don't | repo-verified |
| 3 | Kaufman, P. J. — Efficiency Ratio (Kaufman's Adaptive Moving Average), as documented by StockCharts ChartSchool | https://chartschool.stockcharts.com/table-of-contents/technical-indicators-and-overlays/technical-overlays/kaufmans-adaptive-moving-average-kama | formula of `steady`: "ER = Change/Volatility" (net change ÷ sum of absolute moves); I use signed log moves over the post-discovery window instead of 10 periods | secondary (formula V on that page; the original book, Kaufman's *Smarter Trading* 1995, not read) |
| 4 | Menger, C. (1892). "On the Origin of Money." *Economic Journal* 2(6), 239–255. | doi:10.2307/2956146 · https://academic.oup.com/ej/article/2/6/239/5302150 · full text https://monadnock.net/menger/money.html | `depth`: "those commodities, which relatively to both space and time are most saleable, have in every market become the wares, which it is not only in the interest of every one to accept…" | V-primary (monadnock transcription, via a summarising fetcher; quote not checked against the OUP scan) |
| 5 | Amihud, Y. (2002). "Illiquidity and stock returns: cross-section and time-series effects." *J. Financial Markets* 5(1), 31–56. | doi:10.1016/S1386-4181(01)00024-6 · https://www.sciencedirect.com/science/article/abs/pii/S1386418101000246 | why depth's IC is negative (illiquidity premium) | V-search (PDF fetched but not text-extractable here) |
| 6 | Ang, A., Chen, J. & Xing, Y. (2006). "Downside Risk." *RFS* 19(4), 1191–1239. | https://academic.oup.com/rfs/article-abstract/19/4/1191/1580531 · NBER w11824 | context: assets that fall with the market in declines earn a premium, so a haven signal is expected to trade return for safety | V-search |
| 7 | Hogan-Hennessy, S., Xenopoulos, P. & Silva, C. (2022). "Market Interventions in a Large-Scale Virtual Economy." arXiv:2210.07970. | https://arxiv.org/abs/2210.07970 | game sinks: "the item sink contributed to the inflation of luxury good prices, without reducing trade volume" (Old School RuneScape) | V-abstract (arXiv page) |
| 8 | Jegadeesh, N. (1990). "Evidence of Predictable Behavior of Security Returns." *JF* 45(3), 881–898. | doi:10.1111/j.1540-6261.1990.tb05110.x | the skip-period variant (tested, rejected) | V-search; repo lists abstract VERIFIED |
| 9 | Dawes, R. M. (1979). "The robust beauty of improper linear models in decision making." *Am. Psychologist* 34(7), 571–582. | doi:10.1037/0003-066X.34.7.571 | unit weights | repo (V-abstract) |
| 10 | DeMiguel, V., Garlappi, L. & Uppal, R. (2009). "Optimal Versus Naive Diversification." *RFS* 22(5), 1915–1953. | doi:10.1093/rfs/hhm075 | untuned weights | repo (V-abstract) |
| 11 | Gelman, A. (2006). "Prior distributions for variance parameters in hierarchical models." *Bayesian Analysis* 1(3), 515–533. | https://sites.stat.columbia.edu/gelman/research/published/taumain.pdf | J < 5 groups can't identify pooled parameters | repo-verified |
| 12 | OECD/JRC (2008). *Handbook on Constructing Composite Indicators.* | https://www.oecd.org/sdd/42495745.pdf | geometric (non-compensatory) aggregation — tested, rejected | repo (cited in hold-research-recovered §1) |

#### PoE / PoE2 economy

| # | Citation | URL | Used for | Status |
|---|---|---|---|---|
| 13 | Shalyt, M. (2017-09-11). "Path of Exile Economy: Currency Trading." *Game Developer*. | https://www.gamedeveloper.com/design/path-of-exile-economy-currency-trading | every item is a consumable with "intrinsic functionality and value"; prices "closely correlated to the availability of each single resource" | secondary, quotes via fetcher |
| 14 | timesaver.gg (2026-07-16). "PoE2 Hinekora's Lock Price." | https://timesaver.gg/blog/poe2-hinekoras-lock-price-guide | Lock flat in Divine ("~1,200–1,345 Divine band") while Divine deflated ~27% vs Exalted; "no farm strategy" | secondary |
| 15 | timesaver.gg (2026-07-17). "PoE2 Omens Guide (0.5)." | https://timesaver.gg/blog/poe2-omens-guide | "Ritual is the only source of Omens"; Erasures/Whittling priciest | secondary |
| 16 | Dads of Exile (league-day 14 snapshot). "PoE 2 Omens List (0.5)." | https://dadsofexile.com/omens | "Omen of Light and Omen of Whittling clear more exchange volume than any other omen … consumed in bulk by endgame Desecration crafting" | secondary |
| 17 | Switchblade Gaming, Michael R. (2026-08-04). "PoE2 Economy Guide 2026: Week 1 vs Week 4 Price Curves." | https://www.switchbladegaming.com/path-of-exile-2/economy-guide-4/ | week-1 Divine premium 20–25%; rune demand peaks week 2 | secondary |
| 18 | timesaver.gg. "PoE2 Forbidden Rites League Start Guide (0.5.5)." | https://timesaver.gg/blog/poe2-forbidden-rites-league-start-guide-0-5-5 | "prices are 40–60% inflated versus Week 2 equilibrium" in the first 48h | V-search only |
| 19 | timesaver.gg. "PoE2 Mirror of Kalandra Price." | https://timesaver.gg/blog/poe2-mirror-of-kalandra-price-guide | Mirror ≈ 4× Lock | V-search only |

#### Measurements (this candidate; reproducible)

- `ic.py` (uses `explore_scorer.py`): per-signal daily Spearman IC vs 7d/14d forward return, entry t+2,
  the backtest's eligible universe and `path()`; output `ic7.txt`.
- `ops/hold-backtest.py` runs: `smoke.txt` (current league), `all.json`/`all.txt` (candidate, all
  leagues), `baseline.json`/`baseline.txt` (production, all leagues).
- `peek_final.py <day>`: per-signal ranks on the current league for one day.

Searched and not found: any peer-reviewed study ranking in-game items by value retention (consistent with
the repo's 2026-09-28 note).
