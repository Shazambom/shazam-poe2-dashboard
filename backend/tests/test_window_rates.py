"""A market's price is its window, not its newest hour (owner, 2026-09-20).

A quiet market trades once or twice a day. In 13% of market-hours the 6-hour window holds exactly
ONE traded hour, so that hour alone is the price — and 87% of those hours move 1-2 units, where a
single misclick sets a rate that stands for hours. `traded_bounds` cannot catch it: with one hour
`lo == hi`, so the wide-spread guard reads the market as perfectly steady.

Measured over 197,398 active market-hours of the owner's DB, against what each market actually
traded over the following 24 hours: pricing from the window instead of the newest hour cuts rates
that miss by 2x from 5.2% to 3.8%, and by 5x from 0.7% to 0.3%. A busy market does not move — its
recent hours already carry nearly all the volume.

ACCURACY IS THE WHOLE POINT, so the rules below are invariants, not preferences:

  * The rate is a weighted MEDIANT of hours the market actually traded at, so it can never leave
    the range those hours span. We cannot invent a price nobody paid.
  * A market that repeats one price keeps that price EXACTLY.
  * One traded hour yields that hour's rate exactly — nothing is smoothed into existence.
  * No market gains or loses a price; only the number changes.
  * The two directions stay reciprocal to within one rounding step, so a market can never be
    traded against itself for a profit.

The last two tests hold the first four over the owner's real database rather than over markets
this file invented — 986,834 rows, 23 leagues, 9,688 markets, 670 currencies as of 2026-09-20 —
because a read-path change has to be proved for EVERY currency, not a chosen few (owner,
2026-09-19: "if you lose data for one and the test doesn't cover it you've just lost data with no
recourse"). They skip where that DB is absent, so CI and a fresh clone still run green.

    python -m pytest backend/tests/test_window_rates.py -q
"""
import math
import os
import sqlite3
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db, digest  # noqa: E402
from app.currencies import registry  # noqa: E402

LEAGUE = "WindowLeague"
BROAD = "BroadLeague"


def _row(**kw):
    base = {"vol_a": 1, "vol_b": 1, "hi_stock_a": 100, "hi_stock_b": 100, "hour": 0,
            "lo_ratio_a": 0, "hi_ratio_a": 0, "lo_ratio_b": 0, "hi_ratio_b": 0}
    return {**base, **kw}


def _put(league, rows):
    """rows: (hours_ago, market, cur_a, cur_b, vol_a, vol_b)."""
    h0 = digest._hour(time.time())
    with db.tx() as c:
        c.executemany("INSERT OR REPLACE INTO digest_markets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      [(h0 - ago * 3600, league, m, a, b, va, vb,
                        None, None, 100, 100, None, None, None, None)
                       for ago, m, a, b, va, vb in rows])


def _wipe(league):
    with db.tx() as c:
        c.execute("DELETE FROM digest_markets WHERE league=?", (league,))


@pytest.fixture(autouse=True)
def _fresh_rates():
    """`window_rates` is memoised until a new digest hour lands, and in a test no hour ever lands —
    so without this each test would read the previous one's market."""
    digest._rate_cache.clear()
    yield
    digest._rate_cache.clear()


# ------------------------------------------------------------------ the number itself
def test_a_market_that_repeats_one_price_keeps_that_price_exactly():
    """The invariant that makes this safe to apply to every market in the app: where there is
    nothing to correct, nothing moves. Bit-exact, not approximately — both sides are scaled by
    the same weights, and powers of two scale exactly in binary floating point, so any drift here
    would be an algorithmic one rather than rounding."""
    _wipe(LEAGUE)
    _put(LEAGUE, [(ago, "m", "A", "B", 8, 2) for ago in range(0, 40)])
    assert digest.window_rates(LEAGUE)[("A", "B")] == 4.0


def test_one_traded_hour_is_its_own_rate_exactly():
    """A market with a single observation has nothing to average. We must return that hour, not
    a number derived from it — inventing precision we do not have is the failure being fixed."""
    _wipe(LEAGUE)
    _put(LEAGUE, [(0, "m", "A", "B", 9, 4)])
    assert digest.window_rates(LEAGUE)[("A", "B")] == 2.25


def test_an_hour_one_half_life_old_counts_exactly_half():
    """The decay is the one shape parameter; pin it numerically rather than by feel.
    now: 1 for 1. one half-life ago: 3 for 1. -> (1*1 + 0.5*3) / (1*1 + 0.5*1) = 5/3."""
    _wipe(LEAGUE)
    _put(LEAGUE, [(0, "m", "A", "B", 1, 1), (int(digest.RATE_HALF_LIFE_H), "m", "A", "B", 3, 1)])
    assert digest.window_rates(LEAGUE)[("A", "B")] == pytest.approx(5 / 3, rel=1e-12)


def test_the_busier_hour_decides_between_two_of_the_same_age():
    """Volume is what makes this self-tuning: a liquid market's own recent hours dominate, so it
    keeps its live rate, while a 1-unit hour cannot outvote a real one."""
    _wipe(LEAGUE)
    _put(LEAGUE, [(1, "m", "A", "B", 1000, 1000), (1, "n", "C", "D", 1, 1)])
    _put(LEAGUE, [(2, "m", "A", "B", 5, 1), (2, "n", "C", "D", 5, 1)])
    busy, thin = digest.window_rates(LEAGUE)[("A", "B")], digest.window_rates(LEAGUE)[("C", "D")]
    assert busy < 1.1, "1000 units of 1:1 was outvoted by 5 units of 5:1"
    assert thin > 2.0, "a 1-unit hour should not outweigh a 5-unit one"


def test_hours_older_than_the_window_are_not_read():
    _wipe(LEAGUE)
    _put(LEAGUE, [(0, "m", "A", "B", 1, 1),
                  (int(digest.RATE_WINDOW_H) + 5, "m", "A", "B", 1_000_000, 1)])
    assert digest.window_rates(LEAGUE)[("A", "B")] == 1.0


def test_a_market_that_never_traded_is_absent_not_zero():
    """A missing price and a price of zero are different claims. Zero would value a currency at
    nothing and propagate through every route."""
    _wipe(LEAGUE)
    _put(LEAGUE, [(1, "m", "A", "B", 0, 5), (2, "m", "A", "B", None, None)])
    assert ("A", "B") not in digest.window_rates(LEAGUE)


def test_the_rates_are_keyed_on_raw_metadata_ids():
    """`latest_rates` looks the rate up beside `traded_bounds`, which keys on the raw column."""
    _wipe(LEAGUE)
    ex = registry.metas("exalted")[0]
    _put(LEAGUE, [(1, "m", ex, "B", 4, 1)])
    assert ("exalted", "B") not in digest.window_rates(LEAGUE)
    assert digest.window_rates(LEAGUE)[(ex, "B")] == 4.0


# ------------------------------------------------------------------ broad: every market, no garbage
SHAPES = [(10, 20), (1, 1), (7, 3), (999999, 1), (1, 999999), (3, 7), (250, 4), (4, 250),
          (0, 20), (10, 0), (0, 0), (None, 20), (10, None), (None, None), (None, 0), (0, None)]
MARKETS = 240
HOURS = 50


def _fill_broad():
    """Every market sees every volume shape, so no market is special and every shape a volume
    column can take is exercised against every code path."""
    with db.q() as c:
        if c.execute("SELECT 1 FROM digest_markets WHERE league=? LIMIT 1", (BROAD,)).fetchone():
            return
    rows = []
    for p in range(MARKETS):
        a, b = (f"a{p}", f"b{p}")
        for h in range(HOURS):
            va, vb = SHAPES[(p + h) % len(SHAPES)]
            rows.append((h, f"m{p}", a, b, va, vb))
    # plus real currencies, so metadata resolution is covered too
    ex, dv = registry.metas("exalted")[0], registry.metas("divine")[0]
    for h in range(HOURS):
        rows.append((h, "mreal", dv, ex, 1 + h % 3, 400 + h))
    _put(BROAD, rows)


def _traded_hours(league):
    """{(cur_a, cur_b): [a-per-b each hour it actually traded]} straight from the table."""
    out = {}
    with db.q() as c:
        for r in c.execute("SELECT cur_a, cur_b, vol_a, vol_b FROM digest_markets WHERE league=?",
                           (league,)).fetchall():
            if r["vol_a"] and r["vol_b"]:
                out.setdefault((r["cur_a"], r["cur_b"]), []).append(r["vol_a"] / r["vol_b"])
    return out


def test_every_market_rate_sits_inside_the_prices_that_market_traded_at():
    """THE anti-garbage invariant, asserted for every market rather than a chosen few (owner,
    2026-09-19: "if you lose data for one and the test doesn't cover it you've just lost data with
    no recourse"). A weighted mediant of observed ratios cannot leave their range, so a rate
    outside it means we have invented a price nobody paid."""
    _fill_broad()
    got = digest.window_rates(BROAD, hours=HOURS + 1)
    hours = _traded_hours(BROAD)
    assert len(got) >= MARKETS, f"only {len(got)} markets priced"
    outside = [(k, got[k], min(hours[k]), max(hours[k])) for k in got
               if not (min(hours[k]) <= got[k] <= max(hours[k]))]
    assert not outside, f"{len(outside)} markets priced outside their own traded range, e.g. {outside[:3]}"


def test_every_market_rate_is_a_finite_positive_number():
    """NaN and inf propagate silently through the graph and poison every route that touches them."""
    _fill_broad()
    bad = [(k, v) for k, v in digest.window_rates(BROAD, hours=HOURS + 1).items()
           if not (isinstance(v, float) and math.isfinite(v) and v > 0)]
    assert not bad, f"{len(bad)} markets carry a non-finite or non-positive rate, e.g. {bad[:3]}"


def test_no_market_gains_or_loses_a_price():
    """Only the number changes. A market priced today must still be priced, and one that is not
    must not appear — this change may not add or remove a tradable market anywhere."""
    _fill_broad()
    got = set(digest.window_rates(BROAD, hours=HOURS + 1))
    assert got == set(_traded_hours(BROAD)), \
        f"appeared: {sorted(got - set(_traded_hours(BROAD)))[:3]}, " \
        f"vanished: {sorted(set(_traded_hours(BROAD)) - got)[:3]}"


def test_a_market_whose_every_hour_repeats_is_untouched_across_every_market():
    """The exactness invariant, swept over hundreds of markets rather than one."""
    _wipe("SteadyLeague")
    _put("SteadyLeague", [(h, f"m{p}", f"a{p}", f"b{p}", p + 1, 2)
                          for p in range(200) for h in range(20)])
    got = digest.window_rates("SteadyLeague", hours=25)
    off = [(k, v, (int(k[0][1:]) + 1) / 2) for k, v in got.items()
           if abs(math.log(v / ((int(k[0][1:]) + 1) / 2))) > 1e-15]
    assert not off, f"{len(off)} steady markets drifted, e.g. {off[:3]}"


# ------------------------------------------------------------------ wiring into the priced edges
def test_the_two_directions_stay_reciprocal_to_the_last_bit():
    """Both directions of a market become separate graph edges and a 2-hop cycle multiplies them,
    so any drift above 1 is free money the route search will happily report. Taking both from ONE
    number bounds that drift at a single rounding step — the most floating point allows. (The old
    `vol_b/vol_a` and `vol_a/vol_b` pair had the same one-ulp property; this is not a regression,
    and one ulp cannot clear the liquidity floor a route has to pass.)"""
    for rate in (1.9, 5 / 3, 400.0, 0.0025, 1e-6, 987654.321):
        out = digest.directed_rates("a", "b", _row(vol_a=5, vol_b=3), age=60.0, rate=rate)
        product = out[("a", "b")]["rate"] * out[("b", "a")]["rate"]
        assert abs(product - 1.0) <= 2 * math.ulp(1.0), f"rate={rate} -> product {product!r}"


def test_the_window_rate_is_what_an_active_market_is_priced_at():
    out = digest.directed_rates("a", "b", _row(vol_a=5, vol_b=3), age=60.0, rate=1.25)
    assert out[("b", "a")]["rate"] == 1.25           # a per b
    assert out[("a", "b")]["rate"] == pytest.approx(1 / 1.25)


def test_an_inactive_market_ignores_the_window_and_keeps_its_pessimistic_price():
    """Rule 2 of test_inactive_markets stands: a market whose hours disagree beyond `wide_spread`
    is priced at the dearest/cheapest, never an average. The window must not soften that."""
    out = digest.directed_rates("a", "b", _row(vol_a=5, vol_b=3), age=60.0,
                                bounds=(10.0, 40.0), wide_spread=2.0, rate=1.25)
    assert out[("b", "a")]["rate"] == 10.0           # cheapest a per b when selling b
    assert out[("a", "b")]["rate"] == pytest.approx(1 / 40.0)


# ------------------------------------------------------------------ the whole production dataset
# The unit tests above are synthetic: they prove the rule on markets this file invented. The owner's
# standing rule is that a read-path change must be proved over EVERY currency in the DB, not a
# chosen few — so when the real market DB is on this machine, fold every league of it through the
# implementation and check the invariants on all of it. Read-only, never written to. Slow on
# purpose (~1M rows); skipped anywhere the DB is absent (CI, Windows, a fresh clone).
PROD_DB = Path(os.environ.get(
    "ARBITER_PROD_MARKET_DB",
    Path.home() / "Library/Application Support/Arbiter/data/market.sqlite"))
_prod = pytest.mark.skipif(not PROD_DB.exists(), reason=f"no production market DB at {PROD_DB}")


def _prod_rows():
    con = sqlite3.connect(f"file:{PROD_DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        return con.execute("SELECT league, hour, cur_a, cur_b, vol_a, vol_b FROM digest_markets").fetchall()
    finally:
        con.close()


def _reference(rows, now, half_life_h):
    """The same rule, deliberately computed a DIFFERENT way: every term is collected first and
    summed with `math.fsum`, which is exact regardless of order. The implementation accumulates
    as it goes, so comparing the two over a million real rows is a test of numerical accuracy —
    not a restatement of the same loop. Terms are also fed in the opposite order (oldest first,
    so the smallest weights land first) to expose any order sensitivity."""
    terms = {}
    for r in rows:
        va, vb = r["vol_a"], r["vol_b"]
        if not va or not vb:
            continue
        w = 2.0 ** (-((now - r["hour"]) / 3600.0) / half_life_h)
        e = terms.setdefault((r["league"], r["cur_a"], r["cur_b"]), ([], []))
        e[0].append(w * va)
        e[1].append(w * vb)
    out = {}
    for k, (na, nb) in terms.items():
        a, b = math.fsum(sorted(na)), math.fsum(sorted(nb))
        if b > 0:
            out[k] = a / b
    return out


@_prod
def test_production_every_market_matches_an_exactly_summed_reference():
    """The implementation's running accumulation against exact (`math.fsum`) summation, over every
    league and every currency in the real database. Disagreement means the rate a user is shown
    depends on the order rows came back in."""
    rows = _prod_rows()
    now = max(r["hour"] for r in rows)
    want = _reference(rows, now, digest.RATE_HALF_LIFE_H)
    by_league = {}
    for r in rows:
        by_league.setdefault(r["league"], []).append(r)
    got = {}
    for league, lrows in by_league.items():
        for (a, b), v in digest._fold_rates(lrows, now).items():
            got[(league, a, b)] = v
    assert set(got) == set(want), \
        f"implementation priced {len(got)} markets, reference {len(want)}"
    off = [(k, got[k], want[k]) for k in want if abs(math.log(got[k] / want[k])) > 1e-12]
    assert not off, f"{len(off)} of {len(want)} markets disagree, e.g. {off[:3]}"


@_prod
def test_production_no_market_is_priced_outside_what_it_traded_at():
    """The anti-garbage invariant over the real dataset: ~1M rows, every league, every currency.
    A rate outside a market's own traded range would be a price nobody ever paid."""
    rows = _prod_rows()
    now = max(r["hour"] for r in rows)
    span = {}
    for r in rows:
        if not r["vol_a"] or not r["vol_b"]:
            continue
        px = r["vol_a"] / r["vol_b"]
        k = (r["league"], r["cur_a"], r["cur_b"])
        lo, hi = span.get(k, (px, px))
        span[k] = (min(lo, px), max(hi, px))
    bad, n = [], 0
    by_league = {}
    for r in rows:
        by_league.setdefault(r["league"], []).append(r)
    for league, lrows in by_league.items():
        for (a, b), v in digest._fold_rates(lrows, now).items():
            n += 1
            lo, hi = span[(league, a, b)]
            if not (math.isfinite(v) and v > 0):
                bad.append((league, a, b, v, "not a finite positive number"))
            elif not (lo * (1 - 1e-12) <= v <= hi * (1 + 1e-12)):
                bad.append((league, a, b, v, f"outside [{lo}, {hi}]"))
    assert n > 1000, f"only {n} markets checked — is the production DB populated?"
    assert not bad, f"{len(bad)} of {n} markets priced wrongly, e.g. {bad[:3]}"


def test_a_new_digest_hour_retires_the_cached_rate():
    """The rate is held until a new hour lands. If that stamp failed to invalidate, the app would
    serve a price from before the newest trades for up to a day."""
    _wipe(LEAGUE)
    _put(LEAGUE, [(1, "m", "A", "B", 8, 2)])
    assert digest.window_rates(LEAGUE)[("A", "B")] == 4.0
    _put(LEAGUE, [(0, "m2", "A", "B", 2, 8)])
    assert digest.window_rates(LEAGUE)[("A", "B")] == 4.0, "a rate must not move without a new hour"
    before = digest.state["last_hour"]
    digest.state["last_hour"] = (before or 0) + 3600
    try:
        assert digest.window_rates(LEAGUE)[("A", "B")] < 4.0, "the new hour was not picked up"
    finally:
        digest.state["last_hour"] = before


def test_latest_rates_prices_a_thin_newest_hour_from_the_window():
    """End to end through the function the whole app prices with. A divine market that trades at
    400 exalted all day, then a last hour where ONE divine went for 300: too close to trip the
    wide-spread guard, far enough to matter. The window's volume must outvote that hour."""
    _wipe(LEAGUE)
    ex, dv = registry.metas("exalted")[0], registry.metas("divine")[0]
    _put(LEAGUE, [(h, f"m{h}", dv, ex, 100, 40_000) for h in range(1, 40)])
    _put(LEAGUE, [(0, "m0", dv, ex, 1, 300)])
    got = digest.latest_rates(LEAGUE, max_age_hours=6)[("divine", "exalted")]
    rate = got["rate"]                                   # exalted per divine
    assert not got["inactive"]
    assert rate > 380, f"the 1-divine hour set the price ({rate}); the window says ~400"


def test_latest_rates_still_gives_up_on_a_market_that_wanders():
    """The wide-spread guard is the >2x trip-wire and the window does not soften it: a newest hour
    100x off the rest leaves the market inactive and priced at its extreme, exactly as before."""
    _wipe(LEAGUE)
    ex, dv = registry.metas("exalted")[0], registry.metas("divine")[0]
    _put(LEAGUE, [(h, f"m{h}", dv, ex, 1, 400) for h in range(1, 30)])
    _put(LEAGUE, [(0, "m0", dv, ex, 1, 4)])          # the misclick: 1 divine for 4 exalted
    got = digest.latest_rates(LEAGUE, max_age_hours=6)[("divine", "exalted")]
    assert got["inactive"], "a market that ran 100x over six hours must still be given up on"
    assert got["rate"] == pytest.approx(4.0), "buying divine must still cost the dearest hour"
