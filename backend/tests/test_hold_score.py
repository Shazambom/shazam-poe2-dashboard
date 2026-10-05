"""TDD for Hold's eligibility gate, the Caution dial's plumbing, and the forecast.

See `docs/bugs/2026-09-20-hold-ranks-against-its-own-forecast.md` for the diagnosis and the
backtest that set these constants. The ORDER of the board is `holdscore.hold_rank`, tested in
test_hold_rank.py (2026-09-28; it replaced the sign-safe `log(1+ret) + k·log(1+mdd)` score of
0.3.2, whose monotonicity guarantee test_hold_rank.py carries over to the new ranking).

The gate:

    floor:  top 50% of the day's traded VALUE, and n >= MIN_DAYS        (relative, not absolute)
    cap:    exclude max-drawdown worse than MDD_CAP

SCALE-FREEDOM — the floor must be relative. The value scale shifts ~14x between leagues and the old
absolute VALUE_FLOOR (30M) was unreachable in the first 30 days (0% coverage), so it silently
degenerated into raw volume weighting instead of the cap it looked like.

    python -m pytest backend/tests/test_hold_score.py -q
"""
import math
import os
import sqlite3
import statistics
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import holdscore  # noqa: E402


def m(ret, mdd=-0.10, valvol=1_000_000.0, n=10):
    """A metrics row as `_metrics` builds one. `stab` is derived exactly as production does."""
    return {"ret": ret, "mdd": mdd, "n": n, "valvol": valvol,
            "stab": max(0.15, 1 + mdd), "depth": n / (n + 8.0)}


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
    assert holdscore.CAUTION_K == 2.0         # the Caution default: the dip weighs like every other signal
    assert holdscore.MIN_DAYS == 4
    assert holdscore.VALUE_PERCENTILE == 0.50


# --------------------------------------------------------- 4. the whole production DB

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _proddb import PROD_DB, prod as _prod  # noqa: E402  (opt-in: ARBITER_PROD_TESTS=1)


# ------------------------------------------------ 5. k as a user-facing dial (owner directive)

def test_a_garbage_k_cannot_reach_the_score():
    """The slider is user input arriving over HTTP. Nonsense must clamp, never poison the sort."""
    lo, hi = holdscore.CAUTION_RANGE
    for bad, want in ((-5.0, lo), (999.0, hi), (float("nan"), holdscore.CAUTION_K),
                      (None, holdscore.CAUTION_K), ("2.0", 2.0), (float("inf"), hi)):
        assert holdscore.clamp_k(bad) == want, f"clamp_k({bad!r})"


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

def _series(p0, rate, days=16):
    return {a: (p0 * (1 + rate) ** a, 1e8) for a in range(days)}


def _entries():
    """A day's universe: a blue chip, a steady mid, a spicy winner, a crashed thin rune."""
    return [
        (1, "Mirror of Kalandra", "currency", m(0.53, mdd=-0.189, valvol=495_400_037.0, n=15), _series(4000.0, 0.01)),
        (2, "Her Declaration",    "omen",     m(1.28, mdd=-0.060, valvol=34_559_264.0, n=16), _series(60.0, 0.03)),
        (3, "Omen of the Hunt",   "omen",     m(4.47, mdd=-0.417, valvol=2_503_671.0, n=16), _series(3.0, 0.10)),
        (4, "Lesser Glacial Rune", "rune",    m(-0.751, mdd=-0.85, valvol=144.0, n=6), _series(0.01, -0.10)),
        (5, "Thin Newcomer",      "rune",     m(0.90, mdd=-0.02, valvol=90_000_000.0, n=2), _series(8.0, 0.05, 2)),
    ]


def test_rank_drops_everything_the_contract_excludes():
    out, _score = holdscore._rank(_entries(), holdscore.CAUTION_K)
    names = [e[1] for e in out]
    assert "Omen of the Hunt" not in names      # -41.7% is past the -40% cap
    assert "Lesser Glacial Rune" not in names   # below the value floor AND past the cap
    assert "Thin Newcomer" not in names         # only 2 days of data
    assert "Mirror of Kalandra" in names        # rare but precious — must survive
    assert "Her Declaration" in names


def test_rank_orders_by_hold_rank():
    out, score = holdscore._rank(_entries(), holdscore.CAUTION_K)
    got = [score[e[0]] for e in out]
    assert got == sorted(got, reverse=True)
    want = holdscore.hold_rank([(e[0], e[4]) for e in out], max(max(e[4]) for e in out))
    assert score == want


def test_rank_never_returns_an_ineligible_asset_whatever_k_is():
    k = 0.0
    while k <= 6.0 + 1e-9:
        for e in holdscore._rank(_entries(), k)[0]:
            assert e[3]["mdd"] >= holdscore.MDD_CAP
            assert e[3]["n"] >= holdscore.MIN_DAYS
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


# ------------------------------------------- 8. the forecast reads a phase WINDOW, not one day
#
# See docs/bugs/2026-09-20-hold-open-items-handoff.md, item 1. `_predict` used to read exactly one
# start day per past league, so 2-4 noisy numbers carried the whole forecast. Reading start days
# N-w..N+w in each past league keeps the phase alignment and averages out that noise. Measured on the
# early league (3d): IC +0.263 at w=0 -> +0.317 at w=5, and the curve falls off again toward
# day-blind, so the alignment itself still carries information.

def _step_league(step_day, lo=10.0, hi=20.0, days=40):
    """A past league where the item is flat at `lo`, then steps permanently to `hi` on `step_day`."""
    return {1: {a: ((lo if a < step_day else hi), 1e9) for a in range(days)}}


def test_one_freak_start_day_no_longer_dictates_the_forecast():
    """Both past leagues step up exactly across the aligned window N -> N+3, and are flat on every
    neighbouring start day. Read at one day, that coincidence becomes a +100% forecast. Read over a
    window, it is one event among many flat ones."""
    past = [("B", _step_league(13)), ("A", _step_league(13))]
    one_day = holdscore._predict(1, 10, 3, past, window=0)
    windowed = holdscore._predict(1, 10, 3, past, window=5)
    assert one_day["pred"] == pytest.approx(1.0, abs=1e-9)      # the single day says "+100%"
    assert 0.0 < windowed["pred"] < 0.5                          # the neighbourhood says "some"


def test_leaving_window_out_is_exactly_the_old_forecast():
    """The league-arc projection shares `_predict` and was never measured with a window, so the
    default must reproduce today's numbers bit for bit."""
    past = [("B", _step_league(13)), ("A", _step_league(12))]
    for N, d in ((5, 3), (10, 3), (11, 7), (20, 1)):
        assert holdscore._predict(1, N, d, past) == holdscore._predict(1, N, d, past, window=0)


def test_the_board_reads_the_window_and_nothing_else_does(monkeypatch):
    """Wiring: the leaderboard passes PRED_WINDOW. (The league-arc keeps the default, pinned above.)"""
    from app import currencies, movers
    liquid = {a: (10.0 + a, 1e9) for a in range(10)}
    cur = {7: dict(liquid), 8: dict(liquid)}
    past = [("B", {7: dict(liquid), 8: dict(liquid)}), ("A", {7: dict(liquid), 8: dict(liquid)})]
    meta = {7: ("Seven", "omen"), 8: ("Eight", "omen")}
    monkeypatch.setattr(holdscore, "build_context", lambda num_id: ("Now", cur, past, meta))
    monkeypatch.setattr(holdscore, "_arc_weights", lambda name: None)
    monkeypatch.setattr(movers, "exchange_cards", lambda names, hours, num=None: {})
    monkeypatch.setattr(currencies.registry, "resolve_meta", lambda meta_id: "divine")
    seen, real = [], holdscore._predict

    def spy(*a, **kw):
        seen.append(kw.get("window", 0))
        return real(*a, **kw)

    monkeypatch.setattr(holdscore, "_predict", spy)
    holdscore._leaderboard("3d", "all", "divine", 291, "Divine Orb", holdscore.CAUTION_K)
    assert seen, "the board never asked for a forecast — the test would be vacuous"
    assert set(seen) == {holdscore.PRED_WINDOW}
    assert holdscore.PRED_WINDOW > 0


def _early_league_forecasts(delta, windows, first_day=1, last_day=14):
    """Walk-forward over the REAL leagues: for every league with >=2 prior leagues, every league-day
    N in [first_day, last_day] (default: the opening fortnight, where the board has signal), every
    asset the board would rank that day,
    yield (series, N, {window: _predict(...)}) — only when every window produced a forecast, so all
    widths are compared on identical rows. Reads only data up to N for the current league."""
    from app import marketseries
    con = sqlite3.connect(f"file:{PROD_DB}?mode=ro", uri=True)
    try:
        rows = marketseries.read_rows(con)
    finally:
        con.close()
    by_league: dict = {}
    for lg, iid, day, close, vol in rows:
        by_league.setdefault(lg, []).append((iid, day, close, vol))
    built, day0 = {}, {}
    for lg, rws in by_league.items():
        built[lg], day0[lg] = holdscore._build_league(rws, marketseries.DIVINE_ID)
    order = sorted(built, key=lambda lg: day0[lg] or "")
    for li, target in enumerate(order):
        if li < holdscore.MIN_PRED_LEAGUES:
            continue
        past = [(lg, built[lg]) for lg in reversed(order[:li])]
        for N in range(first_day, last_day + 1):
            ranked = []
            for iid, series in built[target].items():
                if iid == marketseries.DIVINE_ID:
                    continue
                mm = holdscore._metrics({a: v for a, v in series.items() if a <= N}, delta)
                if mm:
                    ranked.append((iid, mm, series))
            if len(ranked) < 8:
                continue
            cut = holdscore.value_cut([r[1] for r in ranked])
            day = []
            for iid, mm, series in ranked:
                if not holdscore.eligible(mm, cut):
                    continue
                preds = {w: holdscore._predict(iid, N, delta, past, window=w) for w in windows}
                if all(preds.values()):
                    day.append((series, preds))
            yield N, day


@_prod
def test_the_shipped_window_beats_one_day_on_the_real_leagues():
    """The claim the window rests on, re-measured against reality every run.

    Walk-forward over every league that has >=2 prior leagues, opening fortnight (league-days <=14,
    where the board has signal), 3d horizon, eligible board only. For each day, the cross-sectional
    Spearman between the forecast and the return that actually followed; averaged over days. The
    forecast reads only PAST leagues, so no gap is needed (see the handoff's measurement-trap note).
    Measured 2026-09-20: +0.263 at one day, +0.317 at the shipped width."""
    def spearman(xs, ys):
        def ranks(v):
            o = sorted(range(len(v)), key=v.__getitem__)
            r = [0.0] * len(v)
            for pos, i in enumerate(o):
                r[i] = float(pos)
            return r
        rx, ry = ranks(xs), ranks(ys)
        mx, my = sum(rx) / len(rx), sum(ry) / len(ry)
        num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
        den = (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** 0.5
        return num / den if den else None

    delta, ics = 3, {0: [], holdscore.PRED_WINDOW: []}
    for N, day in _early_league_forecasts(delta, ics):
        rows_ = []
        for series, preds in day:
            if holdscore._nearest(series, N) is None or holdscore._nearest(series, N + delta) is None:
                continue
            realized = holdscore._smooth(series, N + delta) / holdscore._smooth(series, N) - 1
            rows_.append((realized, preds))
        if len(rows_) < 8:
            continue
        for w in ics:
            ic = spearman([p[w]["pred"] for _r, p in rows_], [r for r, _p in rows_])
            if ic is not None:
                ics[w].append(ic)

    assert len(ics[0]) >= 20, f"only {len(ics[0])} league-days measured — test would be vacuous"
    one_day = sum(ics[0]) / len(ics[0])
    windowed = sum(ics[holdscore.PRED_WINDOW]) / len(ics[holdscore.PRED_WINDOW])
    assert one_day > 0.10, f"the forecast has lost its early-league skill entirely ({one_day:+.3f})"
    assert windowed > one_day + 0.02, (
        f"the window no longer earns its keep: {windowed:+.3f} vs {one_day:+.3f} at one day")


# ------------------------------------------------ 9. the band carries the start-day spread
#
# Averaging start days inside each league BEFORE taking the cross-league spread launders the
# start-day noise out of the band: measured on the live board it shrank the 3d band from 36.4% to
# 15.4%. Overlapping-data inference (Hedegaard & Hodrick, NBER WP 19969) says the opposite should
# happen — varying the start date reveals variation a single-day read hides, "resulting in a larger
# standard error". So the band is the spread of every start-day read, pooled across leagues.

def _zigzag_league(days=60):
    """Flat blocks of three days alternating 10 / 20 — survives the ±1-day median smoothing, so a
    3-day return is +100%, -50% or flat depending purely on which start day you read."""
    return {1: {a: ((10.0 if (a // 3) % 2 == 0 else 20.0), 1e9) for a in range(days)}}


def test_the_band_sees_a_forecast_that_swings_with_the_start_day():
    """Two identical past leagues: their window means agree exactly, so a cross-league spread of
    means is 0 — a confident-looking forecast. But the individual reads swing between +100% and
    -50%. The band must say so."""
    past = [("B", _zigzag_league()), ("A", _zigzag_league())]
    pr = holdscore._predict(1, 20, 3, past, window=5)
    assert pr["band"] > 0.3, f"band {pr['band']:.3f} hides a forecast that swings by +/-70% per day"


@_prod
def test_widening_does_not_tighten_the_typical_band_on_the_real_leagues():
    """The trap in the window change, re-measured against reality: across every early-league day of
    every league with >=2 priors, the typical (median) band at the shipped width must be no narrower
    than at one day. Measured 2026-09-20: 0.150 -> 0.282 over 1942 forecasts.

    Typical, not every: on a given day it can go the other way. Forbidden Rites' league-day 16 (3d)
    tightened 36.3% -> 31.2% because day 16 sits on a volatile stretch of the past leagues — its
    one-day band was 1.57x its neighbours'. That is the single-day noise this change removes."""
    delta, bands = 3, {0: [], holdscore.PRED_WINDOW: []}
    for _N, day in _early_league_forecasts(delta, bands):
        for _series, preds in day:
            for w in bands:
                bands[w].append(preds[w]["band"])

    assert len(bands[0]) >= 200, f"only {len(bands[0])} forecasts measured — test would be vacuous"
    one_day = statistics.median(bands[0])
    windowed = statistics.median(bands[holdscore.PRED_WINDOW])
    assert windowed >= one_day, (
        f"widening tightened the band: median {windowed:.3f} vs {one_day:.3f} at one day")


# ------------------------------------------------- 10. the forecast shows as arrows, not a %
#
# Everything measured about the forecast is ORDERING (a rank correlation). Its magnitude was never
# validated, and its ± is 4-22x too narrow — so the column shows a direction and a strength, not a
# number. Measured 2026-09-20 over every early-league forecast: of the schemes tried, direction from
# the forecast's sign + strength from its rank that day + a dash for the weakest quarter is the one
# whose down arrows beat chance at 3d and 7d, with ordering tied for best at every horizon.

def test_no_forecast_stays_no_forecast():
    out = holdscore.arrows([None, 0.1, None])
    assert out[0] is None and out[2] is None


def test_direction_comes_from_the_sign():
    preds = [0.30, 0.20, 0.10, 0.05, -0.05, -0.10, -0.20, -0.30]
    out = holdscore.arrows(preds)
    for p, a in zip(preds, out):
        if a:                                   # dashes carry no direction
            assert (a > 0) == (p > 0), f"{p:+} got {a}"


def test_the_weakest_quarter_is_a_dash():
    preds = [0.40, 0.30, 0.20, 0.01, -0.02, -0.25, -0.35, -0.45]   # 8 → 2 weakest by |pred|
    out = holdscore.arrows(preds)
    assert out[3] == 0 and out[4] == 0
    assert sum(a == 0 for a in out) == 2


def test_strength_is_rank_within_its_direction():
    ups = [0.9, 0.5, 0.4, 0.3, 0.2, 0.15]
    out = holdscore.arrows(ups + [0.0001, 0.0002])       # the two tiny ones take the dash quarter
    assert out[0] == 3                                     # strongest up -> three arrows
    assert out[5] == 1                                     # weakest shown up -> one arrow
    assert out[:6] == sorted(out[:6], reverse=True)        # never more arrows for a weaker forecast


def test_arrows_are_scale_free():
    """Strength comes from RANK, not size — the magnitude is the part we never validated."""
    preds = [0.3, 0.2, 0.1, 0.05, -0.05, -0.1, -0.2, -0.3, None]
    assert holdscore.arrows(preds) == holdscore.arrows([p * 10 if p else p for p in preds])


def _arrow_outcomes(delta, first_day, last_day):
    """Walk the real leagues; for every forecast the board would show, (arrow, realized return),
    plus the share of all forecasts that rose (the chance rate an arrow has to beat)."""
    shown, rose = [], []
    for N, day in _early_league_forecasts(delta, (holdscore.PRED_WINDOW,), first_day, last_day):
        rows = []
        for series, preds in day:
            if holdscore._nearest(series, N) is None or holdscore._nearest(series, N + delta) is None:
                continue
            r = holdscore._smooth(series, N + delta) / holdscore._smooth(series, N) - 1
            rows.append((preds[holdscore.PRED_WINDOW]["pred"], r))
        if len(rows) < 8:
            continue
        for a, (_p, r) in zip(holdscore.arrows([p for p, _r in rows]), rows):
            shown.append((a, r))
            rose.append(r > 0)
    return shown, sum(rose) / len(rose)


@_prod
@pytest.mark.parametrize("delta", [3, 7])
def test_early_arrows_point_the_right_way_more_often_than_chance(delta):
    """Up means up, down means down — measured on absolute returns, not merely beating neighbours."""
    shown, base = _arrow_outcomes(delta, 1, holdscore.ARROW_LAST_DAY)
    up = [r for a, r in shown if a and a > 0]
    dn = [r for a, r in shown if a and a < 0]
    assert len(up) > 200 and len(dn) > 100, "too few arrows to judge"
    up_hit = sum(r > 0 for r in up) / len(up)
    dn_hit = sum(r < 0 for r in dn) / len(dn)
    assert up_hit > base + 0.05, f"{delta}d: up arrows rose {up_hit:.0%}, chance {base:.0%}"
    assert dn_hit > (1 - base) + 0.05, f"{delta}d: down arrows fell {dn_hit:.0%}, chance {1 - base:.0%}"


@_prod
def test_after_the_cutoff_down_arrows_would_mislead():
    """Why the column hides after ARROW_LAST_DAY: past it, a red arrow falls LESS often than chance."""
    shown, base = _arrow_outcomes(3, holdscore.ARROW_LAST_DAY + 1, 30)
    dn = [r for a, r in shown if a and a < 0]
    assert len(dn) > 30, "too few arrows to judge"
    dn_hit = sum(r < 0 for r in dn) / len(dn)
    assert dn_hit < 1 - base, f"down arrows fell {dn_hit:.0%} vs chance {1 - base:.0%} — the cutoff may be wrong"


def _arrow_board(monkeypatch, league_day, category="all", horizon="3d"):
    """A small realistic board at `league_day`: 8 liquid, flat assets in two categories, and two
    past leagues in which each asset trended at a different rate — so forecasts differ in sign
    and size and every arrow bucket gets used."""
    from app import currencies, movers
    growth = [-0.05, -0.03, -0.015, -0.005, 0.005, 0.015, 0.03, 0.05]
    cur = {i: {a: (10.0, 1e9) for a in range(league_day + 1)} for i in range(1, 9)}
    trend = {i: {a: (10.0 * (1 + growth[i - 1]) ** a, 1e9) for a in range(60)} for i in range(1, 9)}
    past = [("B", trend), ("A", trend)]
    # categories INTERLEAVE across the forecast range, so a category viewed alone would rank its
    # forecasts differently from the whole board — which is what the category test must catch.
    meta = {i: (f"Asset{i}", "omen" if i % 2 else "rune") for i in range(1, 9)}
    monkeypatch.setattr(holdscore, "build_context", lambda num_id: ("Now", cur, past, meta))
    monkeypatch.setattr(holdscore, "_arc_weights", lambda name: None)
    monkeypatch.setattr(movers, "exchange_cards", lambda names, hours, num=None: {})
    monkeypatch.setattr(currencies.registry, "resolve_meta", lambda meta_id: "divine")
    return holdscore._leaderboard(horizon, category, "divine", 291, "Divine Orb", holdscore.CAUTION_K)


def test_the_board_shows_arrows_not_percentages(monkeypatch):
    board = _arrow_board(monkeypatch, league_day=10)
    assert board["pred_shown"] is True
    arrows = [a["pred_arrows"] for a in board["assets"]]
    assert any(x and x > 0 for x in arrows) and any(x and x < 0 for x in arrows)
    for a in board["assets"]:
        assert not {"pred_pct", "pred_band_pct", "pred_leagues"} & set(a), "the % must not reach the view"


def test_an_assets_arrows_dont_depend_on_the_category_you_view(monkeypatch):
    """Arrows rank a forecast against the WHOLE day's board, so filtering can't restyle an asset."""
    everything = {a["id"]: a["pred_arrows"] for a in _arrow_board(monkeypatch, 10)["assets"]}
    omens = {a["id"]: a["pred_arrows"] for a in _arrow_board(monkeypatch, 10, "omen")["assets"]}
    assert omens and all(everything[i] == v for i, v in omens.items())


def test_past_the_cutoff_the_board_drops_the_forecast(monkeypatch):
    board = _arrow_board(monkeypatch, league_day=holdscore.ARROW_LAST_DAY + 1)
    assert board["pred_shown"] is False
    assert all(a["pred_arrows"] is None for a in board["assets"])


def test_the_last_day_still_shows_it(monkeypatch):
    assert _arrow_board(monkeypatch, league_day=holdscore.ARROW_LAST_DAY)["pred_shown"] is True


def test_the_one_day_board_keeps_the_column_but_only_dashes(monkeypatch):
    """1d arrows fail the bar the longer horizons pass (see the production test below), so on 1d the
    column stays — people switch horizons constantly and the table must not jump — but every row is
    a dash. 3d and 7d show arrows."""
    one_day = _arrow_board(monkeypatch, 10, horizon="1d")
    assert one_day["pred_shown"] is True
    assert all(a["pred_arrows"] is None for a in one_day["assets"])
    for hz in ("3d", "7d"):
        assert any(a["pred_arrows"] for a in _arrow_board(monkeypatch, 10, horizon=hz)["assets"]), hz


def test_past_the_cutoff_the_column_goes_at_every_horizon(monkeypatch):
    for hz in ("1d", "3d", "7d"):
        assert _arrow_board(monkeypatch, holdscore.ARROW_LAST_DAY + 1, horizon=hz)["pred_shown"] is False, hz


@_prod
def test_one_day_down_arrows_are_a_coin_flip():
    """Why 1d hides: even in the opening fortnight, a 1d red arrow does NOT beat chance by the margin
    3d/7d clear (measured 2026-09-20: fell 46% vs 48% chance)."""
    shown, base = _arrow_outcomes(1, 1, holdscore.ARROW_LAST_DAY)
    dn = [r for a, r in shown if a and a < 0]
    assert len(dn) > 100, "too few arrows to judge"
    dn_hit = sum(r < 0 for r in dn) / len(dn)
    assert dn_hit <= (1 - base) + 0.05, (
        f"1d down arrows now fall {dn_hit:.0%} vs chance {1 - base:.0%} — 1d may deserve the column back")


def test_a_fresh_board_reports_itself_to_beta_telemetry(monkeypatch):
    """Beta telemetry: one [hold] line per freshly built board — the league-day, horizon, Caution,
    board size and top 5 — so a beta build's Hold list can be checked without the owner's screen."""
    lines = []
    monkeypatch.setattr(holdscore.devtelemetry, "tlog", lambda tag, msg: lines.append(f"[{tag}] {msg}"))
    board = _arrow_board(monkeypatch, league_day=10)
    assert len(lines) == 1 and lines[0].startswith("[hold] day=10 hz=3d k=2 eligible=")
    assert board["assets"][0]["name"] in lines[0]


def test_categories_are_the_games_own_exchange_categories(monkeypatch):
    """Learnability pass (2026-10-05): Hold showed poe2scout's ids ("lineagesupportgems"). An item the game's
    Currency Exchange lists shows that category (as the Stash groups do); anything else keeps its source name.
    The dropdown and the filter use the same names."""
    game = {"Asset1": "Ritual", "Asset2": "Runes", "Asset3": "Ritual"}
    monkeypatch.setattr(holdscore, "exchange_category", lambda name, groups=None: game.get(name))
    board = _arrow_board(monkeypatch, 10)
    cat = {a["name"]: a["category"] for a in board["assets"]}
    assert (cat["Asset1"], cat["Asset2"], cat["Asset3"]) == ("Ritual", "Runes", "Ritual")
    assert cat["Asset4"] == "rune", "not on the exchange: the source category, unchanged"
    assert {"Ritual", "Runes"} <= set(board["categories"])
    ritual = _arrow_board(monkeypatch, 10, "Ritual")
    assert {a["name"] for a in ritual["assets"]} == {"Asset1", "Asset3"}


def test_exchange_category_reads_the_game_table_through_the_registry(monkeypatch):
    from app import currencies, movers
    monkeypatch.setattr(movers, "_trade_id", lambda name: {"Seraph's Heart": "seraphs-heart"}.get(name))
    monkeypatch.setattr(currencies.registry, "groups", lambda categories=None: {"seraphs-heart": "Gems"})
    assert holdscore.exchange_category("Seraph's Heart") == "Gems"
    assert holdscore.exchange_category("Unknown Thing") is None
