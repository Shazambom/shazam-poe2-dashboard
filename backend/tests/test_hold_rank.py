"""TDD for Hold's ranking: a store-of-value list, not a chase list.

Owner, 2026-09-28: Hold suggests good, SAFE places to park currency against inflation — high-end omens
and expensive currencies typically top it — and it must not over-weight what has just gone up.
Diagnosis, measurements and sources: docs/hold-research.md. The smoke test is ops/hold-backtest.py.

The contract (`holdscore.hold_rank`), every signal measured on smoothed prices (`_smooth`):
    kept   — value kept in the numeraire since price discovery settled (league-day DISCOVERY_DAY),
             up to SKIP_DAYS ago, so a jump in the last days doesn't count
    dip    — the worst peak-to-trough drop since discovery (smoothed: one odd close is not a crash)
    trend  — how steadily it climbs: slope × R² of log price over the TREND_DAYS before the skip
    price  — how expensive it is (the most expensive fifth crashed about half as often, every league)
    record — in earlier leagues' first two months, the share of 14-day holds that kept 80% of their
             value (the item's place in the economy carries over; no record = a neutral rank)
    score  = weighted mean of each signal's percentile rank on the day: kept and trend ½ each (one
             climb), dip k / CAUTION_K (the Caution slider), price 1, record 1. Before discovery
             settles, kept and trend don't rank.
             The list settles: an asset's score is its mean over the last SETTLE_DAYS days.

    python -m pytest backend/tests/test_hold_rank.py -q
"""
import importlib.util
import math
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app import holdscore  # noqa: E402


def series(prices, value=1e8):
    """{age: (price, traded value)} from a list of daily prices starting at league-day 0."""
    return {a: (p, value) for a, p in enumerate(prices)}


def steady(p0, rate, days):
    return [p0 * (1 + rate) ** a for a in range(days)]


def spiked(p0, days, jump_at, jump):
    """Flat, then one leap `jump`× in the last few days — "it just went up"."""
    return [p0 * (jump if a >= jump_at else 1.0) for a in range(days)]


def universe(t=24, extra=()):
    """A day's board: filler at mid prices so percentile ranks mean something, plus `extra`."""
    fill = [(100 + i, series(steady(5 + i, 0.005 * (i % 5 - 2), t + 1))) for i in range(20)]
    return fill + list(extra)


def order(entries, t=24, k=None):
    sc = holdscore.hold_rank(entries, t, k)
    return sorted(sc, key=lambda i: -sc[i])


# ----------------------------------------------------------------- 1. what the list favours

def test_a_steady_expensive_holder_outranks_a_cheap_item_that_just_jumped():
    """The owner's complaint, stated as a test: Perfect Flux leapt in the last days; Hinekora's Lock
    climbed steadily and costs a thousand times more. The Lock ranks first."""
    lock = (1, series(steady(700.0, 0.02, 25)))
    flux = (2, series(spiked(12.0, 25, 22, 2.2)))
    ranked = order(universe(extra=[lock, flux]))
    assert ranked.index(1) < ranked.index(2)
    assert ranked.index(2) >= 5, "a last-days jump alone must not carry an item near the top"


def test_a_jump_in_the_last_days_does_not_count_as_kept_value():
    """kept is measured up to SKIP_DAYS ago: two items identical until then rank the same on it."""
    base = steady(10.0, 0.01, 22)
    a = holdscore._signals(series(base + [base[-1] * 1.01] * 3), 24)
    b = holdscore._signals(series(base + [base[-1] * 3.0] * 3), 24)
    assert a["kept"] == pytest.approx(b["kept"])


def test_one_odd_close_is_not_a_crash():
    """The dip reads smoothed prices: a single-day blip on a thin, expensive asset (Mirror read
    −18.9% raw, −7.7% smoothed on Forbidden Rites) is not a drawdown."""
    p = steady(4000.0, 0.01, 25)
    p[15] *= 0.80
    assert holdscore._signals(series(p), 24)["dip"] > -0.05


def test_before_discovery_settles_only_price_and_a_smooth_path_rank():
    """League-day < DISCOVERY_DAY: there is no settled price to measure kept value from, so the
    most expensive steady asset leads even against a cheap item that is rising faster."""
    t = holdscore.DISCOVERY_DAY - 2
    rich = (1, series(steady(900.0, 0.01, t + 1)))
    racer = (2, series(steady(2.0, 0.30, t + 1)))
    fill = [(100 + i, series(steady(5 + i, 0.0, t + 1))) for i in range(20)]
    ranked = order(fill + [rich, racer], t=t)
    assert ranked[0] == 1


def test_better_on_every_signal_never_ranks_lower():
    """Monotone: an asset at least as good on every signal, and better on one, ranks at least as
    high — at every Caution position the slider can reach."""
    ents = universe(extra=[(1, series(steady(50.0, 0.03, 25))), (2, series(steady(40.0, 0.02, 25)))])
    lo, hi = holdscore.CAUTION_RANGE
    for k in (lo, 1.0, holdscore.CAUTION_K, hi):
        sc = holdscore.hold_rank(ents, 24, k)
        assert sc[1] >= sc[2], f"k={k}"


def test_scores_are_finite_and_bounded():
    ents = universe(extra=[(1, series([1e-9] * 25)), (2, series(steady(1e6, 0.5, 25)))])
    for v in holdscore.hold_rank(ents, 24).values():
        assert math.isfinite(v) and 0.0 <= v <= 1.0


# ------------------------------------------------------- 1b. the record from earlier leagues

def _past(**items):
    """One earlier league: {item_id: prices by league-day}."""
    return [("Past", {iid: series(p) for iid, p in items.items()})]


def test_an_item_that_held_in_earlier_leagues_outranks_one_that_crashed():
    """Same path this league; one kept its value through past leagues' first two months, the other
    kept losing a third of it every fortnight. The record is a property of the item (its drops, the
    crafting that consumes it), and it carries over from league to league."""
    now = steady(40.0, 0.02, 25)
    past = _past(**{"1": steady(40.0, 0.0, 70), "2": steady(40.0, -0.03, 70)})
    ents = universe(extra=[("1", series(now)), ("2", series(now))])
    sc = holdscore.hold_rank(ents, 24, past=past)
    assert sc["1"] > sc["2"]


def test_the_record_only_reads_a_past_leagues_first_two_months():
    """No look-ahead: a still-running earlier league's later days may be in the future of a replayed
    day. Anything after RECORD_TO doesn't count."""
    early = steady(40.0, 0.0, holdscore.RECORD_TO + 1)
    a = holdscore._record("1", _past(**{"1": early + [1.0] * 40}))
    b = holdscore._record("1", _past(**{"1": early + [400.0] * 40}))
    assert a == b == 1.0


def test_no_record_is_neutral_not_a_verdict():
    """An item new this league sits between one with a good record and one with a bad one."""
    now = steady(40.0, 0.02, 25)
    past = _past(**{"1": steady(40.0, 0.0, 70), "2": steady(40.0, -0.03, 70)})
    ents = universe(extra=[("1", series(now)), ("2", series(now)), ("3", series(now))])
    sc = holdscore.hold_rank(ents, 24, past=past)
    assert sc["1"] > sc["3"] > sc["2"]


def test_this_leagues_climb_counts_once():
    """kept and trend both measure this league's rise; together they weigh as one signal, the same
    as price or the dip (the owner: Hold over-weighted what just went up)."""
    w = holdscore._weights(24, holdscore.CAUTION_K)
    assert w["kept"] + w["trend"] == w["price"] == w["dip"] == w["record"] == 1.0


# --------------------------------------------------------------------- 2. the Caution slider

def test_caution_zero_ignores_the_dip_and_high_caution_favours_the_steadier_asset():
    """The slider keeps its meaning: 0 = the dip doesn't count; up = steadier wins."""
    shaky_p = steady(60.0, 0.04, 25)
    for a in range(12, 16):
        shaky_p[a] *= 0.70
    shaky = (1, series(shaky_p))
    calm = (2, series(steady(60.0, 0.025, 25)))
    ents = universe(extra=[shaky, calm])
    s0 = holdscore.hold_rank(ents, 24, 0.0)
    s6 = holdscore.hold_rank(ents, 24, holdscore.CAUTION_RANGE[1])
    assert s0[1] > s0[2]
    assert s6[2] > s6[1]


def test_a_garbage_k_cannot_reach_the_rank():
    for bad in (float("nan"), None, "junk", -5, 999):
        for v in holdscore.hold_rank(universe(), 24, holdscore.clamp_k(bad)).values():
            assert math.isfinite(v)


# --------------------------------------------------------------------------- 3. it settles

def test_one_day_does_not_reshuffle_the_list():
    """Scores average the last SETTLE_DAYS days, so one day's move can't flip two close assets."""
    a = steady(30.0, 0.020, 25)
    b = steady(30.0, 0.021, 25)
    b[24] *= 1.5          # one hot close today
    ents = universe(extra=[(1, series(a)), (2, series(b))])
    one = holdscore._rank_day(ents, 24, holdscore.CAUTION_K)
    settled = holdscore.hold_rank(ents, 24)
    assert abs(settled[1] - settled[2]) < abs(one[1] - one[2]) + 1e-12


# ---------------------------------------------------------------- 4. the smoke test, real DB

PROD_DB = Path(os.environ.get(
    "ARBITER_PROD_MARKET_DB",
    Path.home() / "Library/Application Support/Arbiter/data/market.sqlite"))
_prod = pytest.mark.skipif(not PROD_DB.exists(), reason=f"no production market DB at {PROD_DB}")


def _backtest():
    spec = importlib.util.spec_from_file_location("hold_backtest", ROOT / "ops" / "hold-backtest.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@_prod
def test_hold_passes_its_smoke_test_on_the_current_league_at_every_horizon():
    """Hold its top 10 from every day of the current league, at every horizon the app offers:
    out-earn the no-advice basket, keep value, crash half as often, settle, carry the owner's
    stores of value, don't chase jumps (ops/hold-backtest.py THRESHOLDS)."""
    bt = _backtest()
    _meta, _built, day0, _num = bt.build(str(PROD_DB))
    league = bt.current_league(day0)
    res = bt.grade_leagues(str(PROD_DB), [league], workers=1)[league]
    misses = {label: bt.verdict(r["all"]) for label, r in res.items() if r["all"]}
    assert misses and all(not m for m in misses.values()), f"{league}: {misses}"
