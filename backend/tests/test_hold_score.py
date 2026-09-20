"""TDD for the Hold score — sign safety, the eligibility floor, and the drawdown cap.

See `docs/bugs/2026-09-20-hold-ranks-against-its-own-forecast.md` for the diagnosis and the
backtest that set these constants.

The contract being built:

    floor:  top 50% of the day's traded VALUE, and n >= MIN_DAYS        (relative, not absolute)
    cap:    exclude max-drawdown worse than MDD_CAP
    score:  log(1 + ret) + CAUTION_K * log(stab)                           (sign-safe)

The bug this replaces: `hold = ret * conf * stab`. Multiplying a SIGNED return by factors in
[0,1] reverses the penalty below zero — a deeper drawdown made the score *less* negative, so a
worse loss ranked higher. Measured on the owner's DB: 61% of pairs among the 239 negative-return
assets were inverted, with a rune down 75% sitting 383 places above Mirror down 9%.

Two properties carry the whole fix and every test here is a face of one of them:
  1. MONOTONICITY — a strictly worse asset must never outrank a strictly better one, on either
     side of zero. This is what the old form could not hold.
  2. SCALE-FREEDOM — the floor must be relative. The value scale shifts ~14x between leagues and
     the old absolute VALUE_FLOOR (30M) was unreachable in the first 30 days (0% coverage), so it
     silently degenerated into raw volume weighting instead of the cap it looked like.

    python -m pytest backend/tests/test_hold_score.py -q
"""
import math
import os
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import holdscore  # noqa: E402


def m(ret, mdd=-0.10, valvol=1_000_000.0, n=10):
    """A metrics row as `_metrics` builds one. `stab` is derived exactly as production does."""
    return {"ret": ret, "mdd": mdd, "n": n, "valvol": valvol,
            "stab": max(0.15, 1 + mdd), "depth": n / (n + 8.0)}


# --------------------------------------------------------------------------- 1. sign safety

def test_a_worse_drawdown_never_scores_higher_at_the_same_return():
    """THE bug. Same return, deeper crash → strictly worse score. Both signs."""
    for ret in (+0.50, +0.10, 0.0, -0.10, -0.50):
        mild = holdscore.hold_score(m(ret, mdd=-0.05))
        harsh = holdscore.hold_score(m(ret, mdd=-0.80))
        assert harsh < mild, f"ret={ret}: mdd -80% scored {harsh} >= mdd -5% {mild}"


def test_the_rune_no_longer_outranks_mirror():
    """The production case from the bug report, stated as a test.

    A rune down 75% that crashed hard must rank BELOW Mirror down 9.4% that held steady.
    Under `ret * conf * stab` the rune won by 383 places."""
    rune = holdscore.hold_score(m(-0.751, mdd=-0.85, valvol=144.0, n=6))
    mirror = holdscore.hold_score(m(-0.094, mdd=-0.19, valvol=495_400_037.0, n=15))
    assert rune < mirror


def test_score_is_strictly_increasing_in_return():
    prev = None
    for ret in (-0.90, -0.50, -0.10, 0.0, +0.10, +0.50, +3.0):
        s = holdscore.hold_score(m(ret))
        if prev is not None:
            assert s > prev, f"score not increasing at ret={ret}"
        prev = s


def test_no_pair_of_assets_is_inverted_on_both_axes():
    """Monotonicity over the product order: better-or-equal on return AND on drawdown, strictly
    better on one → strictly higher score. This is the invariant the old form violated."""
    rows = [m(r, mdd=d) for r in (-0.8, -0.3, 0.0, 0.4, 1.5) for d in (-0.9, -0.5, -0.2, -0.02)]
    for a in rows:
        for b in rows:
            if a is b:
                continue
            if a["ret"] >= b["ret"] and a["mdd"] >= b["mdd"] and (
                    a["ret"] > b["ret"] or a["mdd"] > b["mdd"]):
                assert holdscore.hold_score(a) > holdscore.hold_score(b), (
                    f"{a['ret']:+.2f}/{a['mdd']:+.2f} should beat {b['ret']:+.2f}/{b['mdd']:+.2f}")


def test_score_is_finite_for_every_reachable_input():
    """No NaN, no inf — a garbage score would silently poison the sort."""
    for ret in (-0.999999, -0.5, 0.0, 50.0):
        for mdd in (-1.0, -0.9999, -0.5, 0.0):
            s = holdscore.hold_score(m(ret, mdd=mdd))
            assert math.isfinite(s), f"non-finite score at ret={ret} mdd={mdd}"


def test_a_total_loss_does_not_blow_up():
    """ret = -1.0 (priced to zero) must be the worst score, not a crash or -inf."""
    s = holdscore.hold_score(m(-1.0, mdd=-1.0))
    assert math.isfinite(s)
    assert s < holdscore.hold_score(m(-0.99, mdd=-0.99))


# --------------------------------------------------------------- 2. the relative floor + cap

def test_the_floor_keeps_about_half_the_day():
    rows = [m(0.1, valvol=float(v)) for v in range(1, 101)]
    cut = holdscore.value_cut(rows)
    kept = [r for r in rows if holdscore.eligible(r, cut)]
    assert 45 <= len(kept) <= 55, f"kept {len(kept)} of 100"


def test_the_floor_is_scale_free():
    """The value scale shifts ~14x between leagues; the SAME assets must survive either way."""
    small = [m(0.1, valvol=float(v)) for v in range(1, 101)]
    large = [m(0.1, valvol=float(v) * 10_000) for v in range(1, 101)]
    ks = {i for i, r in enumerate(small) if holdscore.eligible(r, holdscore.value_cut(small))}
    kl = {i for i, r in enumerate(large) if holdscore.eligible(r, holdscore.value_cut(large))}
    assert ks == kl


def test_the_floor_never_empties_the_board():
    """An absolute floor emptied 99 of 118 early league-days. A relative one cannot."""
    for scale in (1e-3, 1.0, 1e3, 1e9):
        rows = [m(0.1, valvol=float(v) * scale) for v in range(1, 41)]
        kept = [r for r in rows if holdscore.eligible(r, holdscore.value_cut(rows))]
        assert kept, f"board emptied at scale {scale}"


def test_thin_data_is_excluded():
    cut = holdscore.value_cut([m(0.1, valvol=1e6)])
    assert not holdscore.eligible(m(0.1, valvol=1e9, n=holdscore.MIN_DAYS - 1), cut)
    assert holdscore.eligible(m(0.1, valvol=1e9, n=holdscore.MIN_DAYS), cut)


def test_the_drawdown_cap_excludes_at_the_documented_line():
    cut = holdscore.value_cut([m(0.1, valvol=1e6)])
    assert holdscore.eligible(m(5.0, mdd=holdscore.MDD_CAP + 0.001, valvol=1e9), cut)
    assert not holdscore.eligible(m(5.0, mdd=holdscore.MDD_CAP - 0.001, valvol=1e9), cut)


def test_the_cap_spares_the_hard_anchors():
    """Owner steer: Mirror and Hinekora's Lock are safe parks that happen to trade rarely. They
    take real drawdowns (~-19%, ~-13% on Forbidden Rites d16) and MUST survive. At -35% they were
    excluded 25%/27% of early-league days; -40% keeps them."""
    cut = holdscore.value_cut([m(0.1, valvol=1e6)])
    for name, mdd, valvol in (("Mirror", -0.189, 495_400_037.0),
                              ("Hinekora's Lock", -0.132, 201_349_369.0),
                              ("Divine Orb", 0.0, 1e9)):
        assert holdscore.eligible(m(0.5, mdd=mdd, valvol=valvol, n=15), cut), name


def test_rarity_is_not_punished():
    """The floor is on VALUE traded, not unit count — a rare, expensive, steady asset must clear
    it while a high-churn cheap one need not."""
    rare = m(0.2, mdd=-0.10, valvol=200_000_000.0, n=15)   # few trades, enormous value
    churn = m(0.2, mdd=-0.10, valvol=5_000.0, n=15)        # many trades, trivial value
    cut = holdscore.value_cut([rare, churn] + [m(0.1, valvol=1e6) for _ in range(20)])
    assert holdscore.eligible(rare, cut)
    assert not holdscore.eligible(churn, cut)


# ------------------------------------------------------------------- 3. tuning constants

def test_the_constants_match_the_backtest():
    """These are not free parameters — each was measured. Changing one means re-running the
    backtest in docs/bugs/2026-09-20-hold-ranks-against-its-own-forecast.md."""
    assert holdscore.MDD_CAP == -0.40      # tightest cap sparing Mirror/Hinekora (-35% cuts them 25%/27%)
    assert holdscore.CAUTION_K == 2.0         # reproduces production's crash rate + blue-chip mix; saturates at 3
    assert holdscore.MIN_DAYS == 4
    assert holdscore.VALUE_PERCENTILE == 0.50


def test_k_actually_penalises_drawdown_proportionally():
    """k is the dial the backtest swept. It must genuinely weight the drawdown term."""
    steady, shaky = m(0.5, mdd=-0.02), m(0.5, mdd=-0.60)
    gap = holdscore.hold_score(steady) - holdscore.hold_score(shaky)
    assert gap == pytest.approx(
        holdscore.CAUTION_K * (math.log(0.98) - math.log(0.40)), rel=1e-9)


# --------------------------------------------------------- 4. the whole production DB

PROD_DB = Path(os.environ.get(
    "ARBITER_PROD_MARKET_DB",
    Path.home() / "Library/Application Support/Arbiter/data/market.sqlite"))
_prod = pytest.mark.skipif(not PROD_DB.exists(), reason=f"no production market DB at {PROD_DB}")


@_prod
def test_no_inversion_anywhere_in_the_real_league_daily_table():
    """The broad guarantee: over every (item, day) the real DB holds, no asset that is worse on
    BOTH return and drawdown may outrank a better one. This is the property that failed in
    production for 61% of negative-return pairs."""
    con = sqlite3.connect(f"file:{PROD_DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT league, item_id, day, close, volume FROM league_daily "
            "WHERE close > 0 ORDER BY league, item_id, day").fetchall()
    finally:
        con.close()
    if not rows:
        pytest.skip("league_daily is empty")

    series: dict = {}
    for r in rows:
        series.setdefault((r["league"], r["item_id"]), []).append((r["close"], r["volume"]))

    built = []
    for key, pts in series.items():
        if len(pts) < 2:
            continue
        prices = [p for p, _v in pts]
        peak, mdd = prices[0], 0.0
        for p in prices:
            peak = max(peak, p)
            mdd = min(mdd, p / peak - 1)
        ret = prices[-1] / prices[0] - 1
        built.append(m(ret, mdd=mdd, n=len(pts)))
    assert len(built) > 500, f"only {len(built)} real series built — test would be vacuous"

    scored = [(holdscore.hold_score(x), x) for x in built]
    scored.sort(key=lambda t: t[0])
    # Walk in score order: a later (higher-scoring) row may never dominate-worse an earlier one.
    for i in range(len(scored) - 1):
        s_lo, a = scored[i]
        s_hi, b = scored[i + 1]
        if b["ret"] <= a["ret"] and b["mdd"] <= a["mdd"] and (
                b["ret"] < a["ret"] or b["mdd"] < a["mdd"]):
            pytest.fail(
                f"inversion: ret={b['ret']:+.3f}/mdd={b['mdd']:+.3f} scored {s_hi:.6f} above "
                f"ret={a['ret']:+.3f}/mdd={a['mdd']:+.3f} at {s_lo:.6f}")


@_prod
def test_every_real_series_scores_finite():
    """No garbage data: every asset the DB actually holds must produce a usable number."""
    con = sqlite3.connect(f"file:{PROD_DB}?mode=ro", uri=True)
    try:
        rows = con.execute(
            "SELECT close FROM league_daily WHERE close IS NOT NULL").fetchall()
    finally:
        con.close()
    if not rows:
        pytest.skip("league_daily is empty")
    for (close,) in rows[:200_000]:
        if close is None or close <= 0:
            continue
        s = holdscore.hold_score(m(min(50.0, close / 1000.0), mdd=-0.5))
        assert math.isfinite(s)


# ------------------------------------------------ 5. k as a user-facing dial (owner directive)

def test_hold_score_accepts_an_explicit_k():
    steady, shaky = m(0.5, mdd=-0.02), m(0.5, mdd=-0.60)
    for k in (0.0, 0.5, 2.0, 6.0):
        gap = holdscore.hold_score(steady, k) - holdscore.hold_score(shaky, k)
        assert gap == pytest.approx(k * (math.log(0.98) - math.log(0.40)), rel=1e-9)


def test_k_defaults_to_the_setting():
    assert holdscore.hold_score(m(0.3, mdd=-0.2)) == holdscore.hold_score(m(0.3, mdd=-0.2),
                                                                          holdscore.CAUTION_K)


def test_k_zero_is_pure_return_ranking():
    """The dial's floor: drawdown stops mattering entirely, order is by return alone."""
    rows = [m(r, mdd=d) for r, d in ((0.1, -0.9), (0.2, -0.01), (0.3, -0.5))]
    ranked = sorted(rows, key=lambda x: -holdscore.hold_score(x, 0.0))
    assert [r["ret"] for r in ranked] == [0.3, 0.2, 0.1]


def test_turning_the_dial_up_favours_the_steadier_asset():
    """The dial must actually change the ORDER, or it is decoration."""
    spicy, steady = m(3.0, mdd=-0.38), m(0.8, mdd=-0.03)
    assert holdscore.hold_score(spicy, 0.5) > holdscore.hold_score(steady, 0.5)
    assert holdscore.hold_score(spicy, 6.0) < holdscore.hold_score(steady, 6.0)


def test_monotonicity_holds_at_every_k_the_slider_can_reach():
    """The slider must not be able to reintroduce the bug at any position."""
    rows = [m(r, mdd=d) for r in (-0.8, -0.2, 0.0, 0.5, 2.0) for d in (-0.95, -0.4, -0.1, -0.01)]
    lo, hi = holdscore.CAUTION_RANGE
    k = lo
    while k <= hi + 1e-9:
        for a in rows:
            for b in rows:
                if a is b:
                    continue
                if a["ret"] >= b["ret"] and a["mdd"] >= b["mdd"] and (
                        a["ret"] > b["ret"] or a["mdd"] > b["mdd"]):
                    assert holdscore.hold_score(a, k) >= holdscore.hold_score(b, k), f"k={k}"
        k += 0.25


def test_a_garbage_k_cannot_reach_the_score():
    """The slider is user input arriving over HTTP. Nonsense must clamp, never poison the sort."""
    lo, hi = holdscore.CAUTION_RANGE
    for bad, want in ((-5.0, lo), (999.0, hi), (float("nan"), holdscore.CAUTION_K),
                      (None, holdscore.CAUTION_K), ("2.0", 2.0), (float("inf"), hi)):
        assert holdscore.clamp_k(bad) == want, f"clamp_k({bad!r})"
    assert math.isfinite(holdscore.hold_score(m(0.2), holdscore.clamp_k(float("nan"))))


def test_the_default_k_is_inside_its_own_range():
    lo, hi = holdscore.CAUTION_RANGE
    assert lo <= holdscore.CAUTION_K <= hi


def test_the_setting_exists_with_the_backtested_default():
    from app import settings as st
    assert st.DEFAULTS["hold_caution"] == holdscore.CAUTION_K
    assert st.hold_caution({}) == holdscore.CAUTION_K
    assert st.hold_caution({"hold_caution": 4.0}) == 4.0
    assert st.hold_caution({"hold_caution": "junk"}) == holdscore.CAUTION_K


def test_k_is_part_of_the_leaderboard_cache_key():
    """THE TRAP: `leaderboard` memoizes on horizon|category|numeraire. If k is not in the key the
    slider appears to do nothing for the 10-minute TTL."""
    seen = []

    def fake(horizon, category, numeraire, num_id, num_name, k):
        seen.append(k)
        return {"assets": [], "k": k}

    holdscore.invalidate()
    orig = holdscore._leaderboard
    holdscore._leaderboard = fake
    try:
        a = holdscore.leaderboard("3d", "all", "divine", k=1.0)
        b = holdscore.leaderboard("3d", "all", "divine", k=5.0)
        c = holdscore.leaderboard("3d", "all", "divine", k=1.0)
    finally:
        holdscore._leaderboard = orig
        holdscore.invalidate()
    assert seen == [1.0, 5.0], f"k missing from the cache key (built {seen})"
    assert a["k"] == 1.0 and b["k"] == 5.0 and c["k"] == 1.0


def test_the_leaderboard_reports_the_k_it_used():
    """The slider needs to render its own position from the response."""
    import inspect
    assert "k" in inspect.signature(holdscore.leaderboard).parameters


# ------------------------------------------------------- 6. the board actually uses all this

def _entries():
    """A day's universe: a blue chip, a steady mid, a spicy winner, a crashed thin rune."""
    return [
        (1, "Mirror of Kalandra", "currency", m(0.53, mdd=-0.189, valvol=495_400_037.0, n=15)),
        (2, "Her Declaration",    "omen",     m(1.28, mdd=-0.060, valvol=34_559_264.0, n=16)),
        (3, "Omen of the Hunt",   "omen",     m(4.47, mdd=-0.417, valvol=2_503_671.0, n=16)),
        (4, "Lesser Glacial Rune", "rune",    m(-0.751, mdd=-0.85, valvol=144.0, n=6)),
        (5, "Thin Newcomer",      "rune",     m(0.90, mdd=-0.02, valvol=90_000_000.0, n=2)),
    ]


def test_rank_drops_everything_the_contract_excludes():
    out = holdscore._rank(_entries(), holdscore.CAUTION_K)
    names = [n for _i, n, _c, _m in out]
    assert "Omen of the Hunt" not in names      # -41.7% is past the -40% cap
    assert "Lesser Glacial Rune" not in names   # below the value floor AND past the cap
    assert "Thin Newcomer" not in names         # only 2 days of data
    assert "Mirror of Kalandra" in names        # rare but precious — must survive
    assert "Her Declaration" in names


def test_rank_orders_by_hold_score():
    out = holdscore._rank(_entries(), holdscore.CAUTION_K)
    scores = [holdscore.hold_score(mm, holdscore.CAUTION_K) for _i, _n, _c, mm in out]
    assert scores == sorted(scores, reverse=True)


def test_the_dial_reorders_the_real_board():
    """k=0 should prefer the bigger gain; a high k should prefer the steadier one.

    Needs a realistic universe: the floor is the top 50% of the DAY, so a two-asset fixture would
    cut one of them purely for being the smaller of two."""
    filler = [(100 + i, f"filler{i}", "rune", m(0.0, mdd=-0.05, valvol=1_000.0, n=10))
              for i in range(10)]
    spicy = (9, "Spicy", "omen", m(3.0, mdd=-0.39, valvol=5e8, n=15))
    steady = (2, "Her Declaration", "omen", m(1.28, mdd=-0.060, valvol=34_559_264.0, n=16))
    entries = [spicy, steady] + filler
    first = lambda k: holdscore._rank(entries, k)[0][1]  # noqa: E731
    assert first(0.0) == "Spicy"            # +300% beats +128% on return alone
    assert first(6.0) == "Her Declaration"  # but -6% drawdown beats -39% once steadiness weighs


def test_rank_never_returns_an_ineligible_asset_whatever_k_is():
    k = 0.0
    while k <= 6.0 + 1e-9:
        for _i, _n, _c, mm in holdscore._rank(_entries(), k):
            assert mm["mdd"] >= holdscore.MDD_CAP
            assert mm["n"] >= holdscore.MIN_DAYS
        k += 0.5


# ---------------------------------------------------------------- 7. the endpoint carries k

def test_the_hold_endpoint_accepts_and_clamps_k():
    """The slider's value arrives here. It must reach the scorer, and nonsense must not 500."""
    import inspect

    from app import main
    assert "k" in inspect.signature(main.hold).parameters
    seen = {}

    def fake(hz, category, numeraire, k=None):
        seen["k"] = holdscore.clamp_k(k)
        return {"assets": [{"id": 1}], "k": seen["k"]}

    orig = holdscore.leaderboard
    holdscore.leaderboard = fake
    try:
        from fastapi.testclient import TestClient
        c = TestClient(main.app)
        assert c.get("/api/hold?k=4.5").status_code == 200
        assert seen["k"] == 4.5
        assert c.get("/api/hold?k=999").status_code == 200
        assert seen["k"] == holdscore.CAUTION_RANGE[1]
    finally:
        holdscore.leaderboard = orig
