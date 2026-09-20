"""A card's line is the price over time, not what each hour printed (owner, 2026-09-20).

`lib/price.js` states the contract the client relies on: "nothing on a card can contradict
anything else on it" and "the line ends where the number is". Pricing the NUMBER from a 48h
volume-weighted window (`digest.window_rates`) while the LINE stayed a raw per-hour series broke
both. Measured over the 2,582 markets trading in the owner's league, the headline and the
sparkline's last point diverged by a median of 9%, and by more than 50% on 13% of markets.

The case that makes it concrete — Divine <-> Distilled Emotion, 2026-09-20: seven hours trading
one unit at 0.01, then a single 1-for-1 trade. The number reads 0.01 and the line spikes to 1.00,
a hundred times the going rate, at the right-hand edge.

So the line is folded the same way the number is: each point is the volume-weighted, decayed rate
AS OF that hour. One thin hour can no longer spike it, the last point lands on the number, and
`change_pct` — which is measured off the trend array — follows for free.

What must NOT change: `/api/market/history` is the raw record of what executed and stays raw, and
`_align` still combines legs hour by hour at each hour's own rate.

    python -m pytest backend/tests/test_card_coherence.py -q
"""
import importlib
import math
import os
import sqlite3
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db, digest  # noqa: E402

# `app.arbitrage` re-exports a board() FUNCTION under the same name, which shadows the submodule
# for both `from … import board` and `import … as board`. import_module returns the module.
board = importlib.import_module("app.arbitrage.board")

HL = 12.0


def _pts(*rows):
    """(hours_ago, vol_a, vol_b) -> the per-hour series shape `digest.pair_history` returns."""
    h0 = (int(time.time()) // 3600) * 3600
    return [{"hour": h0 - ago * 3600, "rate": vb / va, "volume_a": va, "volume_b": vb}
            for ago, va, vb in sorted(rows, key=lambda r: -r[0])]


# ------------------------------------------------------------------ the fold itself
def test_a_steady_market_folds_to_the_same_price_at_every_point():
    """Where nothing moved, the line must be flat — and flat at the price, not drifting."""
    out = board._fold_series(_pts(*[(ago, 2, 8) for ago in range(30)]))
    assert len(out) == 30
    assert all(p["rate"] == 4.0 for p in out), sorted({p["rate"] for p in out})


def test_one_odd_trade_no_longer_spikes_the_line():
    """The Divine/Distilled Emotion hour: seven single-unit hours at 0.01, then one at 1.00.
    The old line ended at 1.00 — a 100x cliff under a number reading 0.01."""
    raw = _pts((43, 100, 1), (40, 100, 1), (24, 100, 1), (9, 100, 1),
               (7, 100, 1), (6, 100, 1), (5, 200, 2), (2, 1, 1))
    assert raw[-1]["rate"] == 1.0                      # what the line used to end at
    out = board._fold_series(raw)
    assert out[-1]["rate"] < 0.05, f"the odd trade still owns the line ({out[-1]['rate']})"
    assert out[-1]["rate"] > 0.005, "the odd trade was ignored entirely; it is still evidence"


def test_the_fold_never_leaves_the_range_the_market_traded_at():
    """Same anti-garbage invariant as the number: every point is a weighted mediant of hours the
    market really traded at, so the line can never draw a price nobody paid."""
    raw = _pts((30, 1, 5), (20, 3, 3), (12, 7, 2), (6, 1, 9), (1, 4, 4))
    lo = min(p["rate"] for p in raw)
    hi = max(p["rate"] for p in raw)
    for p in board._fold_series(raw):
        assert lo - 1e-12 <= p["rate"] <= hi + 1e-12, p


def test_the_fold_keeps_every_hour_and_its_timestamps():
    raw = _pts((9, 1, 2), (5, 3, 4), (1, 5, 6))
    out = board._fold_series(raw)
    assert [p["hour"] for p in out] == [p["hour"] for p in raw]
    assert all(math.isfinite(p["rate"]) and p["rate"] > 0 for p in out)


def test_an_older_hour_counts_half_as_much_after_one_half_life():
    """The line uses the same decay as the number, so the two cannot drift apart by construction.
    now: 1 for 1. one half-life earlier: 1 for 3. -> (1*1 + 0.5*3) / (1*1 + 0.5*1) = 5/3."""
    out = board._fold_series(_pts((int(HL), 1, 3), (0, 1, 1)))
    assert out[-1]["rate"] == pytest.approx(5 / 3, rel=1e-12)


def test_a_gap_in_the_market_decays_what_came_before_it():
    """Two hours far apart must not count equally — otherwise a market that stopped trading keeps
    an ancient price alive at full weight. Pinned to the decay exactly: one unit at 10, `gap` hours
    old, against one unit at 1 now, weighs 2**(-gap/12).

    Note a distant hour is not negligible just because its weight is small — at 47h it still holds
    6.6% of the weight, and being 10x away that moves the answer to 1.56, not to 1.0."""
    for gap in (1, 12, 47):
        w = 2.0 ** (-gap / HL)
        want = (10 * w + 1) / (1 * w + 1)
        got = board._fold_series(_pts((gap, 1, 10), (0, 1, 1)))[-1]["rate"]
        assert got == pytest.approx(want, rel=1e-12), f"gap={gap}h"
    near = board._fold_series(_pts((1, 1, 10), (0, 1, 1)))[-1]["rate"]
    far = board._fold_series(_pts((47, 1, 10), (0, 1, 1)))[-1]["rate"]
    assert far < near / 3, "the distant hour was not decayed"


# ------------------------------------------------------------------ line meets number
LEAGUE = "CoherenceLeague"


def _seed(rows):
    h0 = (int(time.time()) // 3600) * 3600
    with db.tx() as c:
        c.execute("DELETE FROM digest_markets WHERE league=?", (LEAGUE,))
        c.executemany("INSERT OR REPLACE INTO digest_markets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      [(h0 - ago * 3600, LEAGUE, m, a, b, va, vb,
                        None, None, 100, 100, None, None, None, None)
                       for ago, m, a, b, va, vb in rows])
    digest._rate_cache.clear()


def test_the_line_ends_where_the_number_is():
    """`lib/price.js`'s contract, as a test. The folded series' last point is the same fold over
    the same rows that `digest.window_rates` performs, so the client's line lands on the client's
    number instead of on whatever one hour happened to print."""
    ex, dv = "Metadata/Items/Currency/CurrencyAddModToRare", "Metadata/Items/Currency/CurrencyModValues"
    _seed([(ago, "m", dv, ex, 100, 40_000) for ago in range(1, 40)] + [(0, "m0", dv, ex, 1, 300)])
    number = digest.window_rates(LEAGUE)[(dv, ex)]          # divine per exalted (a per b)
    series = board._fold_series(digest.pair_history(LEAGUE, "divine", "exalted", 72))
    line_end = series[-1]["rate"]                            # exalted per divine (b per a)
    assert line_end == pytest.approx(1.0 / number, rel=1e-9), \
        f"line ends at {line_end}, number says {1/number}"


# ------------------------------------------------------------------ the wiring, through board()
# `_fold_series` being right does not make the CARD right: the fold has to actually reach the
# series the card draws, through `_priced_history` -> `_series`/`_to_ref`/`_align`. Pinning only
# the pure function is what let the wiring break twice (an empty series when a caller supplied
# rates without volumes, and a clock-based trim that discarded every point of a fixture).
BOARD_SETTINGS = {
    "league": LEAGUE, "reference": "exalted", "watchlist": ["chaos", "divine"],
    "max_steps": 3, "max_start_fraction": 1.0, "step_overhead_min": 0.0, "gold_model": {},
    "routes_cache_s": 300, "allow_digest_edges": True, "allow_recipe_edges": False,
    "digest_max_age_h": 6, "live_max_age_s": 1800, "min_edge_volume_ref_per_h": 0,
    "min_edge_depth": 0, "hub_count": 2, "_hub_seed_v1": True, "_liq_floor_v1": True,
    "filters": {"limit": 100},
}
EX = "Metadata/Items/Currency/CurrencyAddModToRare"
DV = "Metadata/Items/Currency/CurrencyModValues"
CH = "Metadata/Items/Currency/CurrencyRerollRare"


@pytest.fixture
def seeded_board(monkeypatch):
    """A league whose markets trade steadily, then print one thin, wrong-looking hour."""
    from app import arbitrage, leaguehistory
    monkeypatch.setattr(leaguehistory, "scout_prices", lambda league: {})
    monkeypatch.setattr(leaguehistory, "scout_history", lambda league, days=60: {})
    rows = []
    for ago in range(1, 60):
        rows += [(ago, f"dv{ago}", DV, EX, 100, 40_000),      # 400 exalted per divine
                 (ago, f"ch{ago}", CH, EX, 1_000, 55_000)]    # 55 exalted per chaos
    # A thin last hour that is WRONG but not wild: both stay inside `wide_spread` (2x), so they
    # take the active path. A market that swings further than that is given up on entirely and
    # priced at its extreme — see test_an_inactive_market_is_priced_outside_this_contract.
    rows += [(0, "dv0", DV, EX, 1, 300),      # 300 vs ~400 exalted per divine — 1.33x
             (0, "ch0", CH, EX, 2, 80)]       # 40 vs ~55 exalted per chaos   — 1.38x
    _seed(rows)
    db.kv_set("settings", BOARD_SETTINGS)
    arbitrage.invalidate_caches()
    yield
    db.kv_set("settings", {})
    arbitrage.invalidate_caches()


@pytest.mark.parametrize("window_h", [24, 72, 168])
def test_a_cards_line_ends_where_its_number_is(seeded_board, window_h):
    """`lib/price.js`'s contract, through the real board. Not bit-exact: `mid` walks the pricing
    chain while the line composes each leg hour by hour (`_align`), so a multi-leg card carries a
    little composition error. Within a percent it reads as one number; at 7% it read as two."""
    out = board.board(window_h=window_h)
    prices = out["prices"]
    checked = 0
    for r in out["rows"]:
        trend, tn = r.get("trend") or [], r.get("trend_num")
        if len(trend) < 2 or r.get("mid") is None or tn not in prices:
            continue
        checked += 1
        head = r["mid"] / prices[tn]
        assert head == pytest.approx(trend[-1]["v"], rel=0.02), \
            f'{r["id"]} @{window_h}h: number {head}, line ends {trend[-1]["v"]}'
    assert checked >= 2, f"only {checked} cards carried a line"


def test_an_inactive_market_is_priced_outside_this_contract(monkeypatch):
    """KNOWN GAP, pinned so it cannot drift silently. A market whose traded hours disagree by more
    than `wide_spread` (2x) is given up on: `directed_rates` prices it at the dearest/cheapest hour
    on purpose (the Tecrod's Gaze rule, owner 2026-09-19), which is a risk stance rather than an
    estimate. The LINE is folded regardless, so on such a card the number and the line still
    disagree. Resolving that means deciding whether valuation and route-feasibility may use the
    same number — a separate call from this change."""
    from app import arbitrage, leaguehistory
    monkeypatch.setattr(leaguehistory, "scout_prices", lambda league: {})
    monkeypatch.setattr(leaguehistory, "scout_history", lambda league, days=60: {})
    rows = [(ago, f"ch{ago}", CH, EX, 1_000, 55_000) for ago in range(1, 60)]
    rows += [(0, "ch0", CH, EX, 2, 20)]                  # 10 vs ~55 — a 5.5x swing, over the 2x gate
    _seed(rows)
    db.kv_set("settings", {**BOARD_SETTINGS, "watchlist": ["chaos"]})
    arbitrage.invalidate_caches()
    try:
        out = board.board(window_h=24)
        row = {r["id"]: r for r in out["rows"]}["chaos"]
        assert row["mid"] == pytest.approx(10.0), "the wide-spread guard stopped pricing the extreme"
        assert row["trend"][-1]["v"] > 40, "the line should still be the folded price"
    finally:
        db.kv_set("settings", {})
        arbitrage.invalidate_caches()


def test_the_thin_last_hour_does_not_become_the_card(seeded_board):
    """The whole point, at card level: one divine went for 300 exalted in the last hour against
    ~400 all week. Neither the number nor the line may follow it."""
    out = board.board(window_h=24)
    row = {r["id"]: r for r in out["rows"]}["divine"]
    in_ex = row["mid"] / out["prices"]["exalted"]
    assert in_ex > 380, f"the number followed the thin hour ({in_ex})"
    line_ex = row["trend"][-1]["v"] * out["prices"][row["trend_num"]] / out["prices"]["exalted"]
    assert line_ex > 380, f"the line followed the thin hour ({line_ex})"


# ------------------------------------------------------------------ the raw record stays raw
def test_the_raw_history_readers_are_untouched():
    """`/api/market/history` is the record of what executed. Folding it there would erase the very
    trades the page exists to show."""
    ex, dv = "Metadata/Items/Currency/CurrencyAddModToRare", "Metadata/Items/Currency/CurrencyModValues"
    _seed([(5, "m", dv, ex, 1, 400), (0, "m0", dv, ex, 1, 4)])
    raw = digest.pair_history(LEAGUE, "divine", "exalted", 72)
    assert raw[-1]["rate"] == pytest.approx(4.0), "pair_history must still return what the hour printed"


# ------------------------------------------------------------------ the whole production DB
PROD_DB = Path(os.environ.get(
    "ARBITER_PROD_MARKET_DB",
    Path.home() / "Library/Application Support/Arbiter/data/market.sqlite"))
_prod = pytest.mark.skipif(not PROD_DB.exists(), reason=f"no production market DB at {PROD_DB}")


@_prod
def test_production_every_line_ends_on_its_own_number():
    """Over every market in the real database: the folded line's last point equals the rate the
    number is built from. Checked for every currency, not a sample."""
    con = sqlite3.connect(f"file:{PROD_DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute("SELECT league, hour, cur_a, cur_b, vol_a, vol_b FROM digest_markets "
                           "WHERE vol_a IS NOT NULL AND vol_a <> 0 AND vol_b IS NOT NULL "
                           "AND vol_b <> 0 ORDER BY hour").fetchall()
    finally:
        con.close()
    now = max(r["hour"] for r in rows)
    by = {}
    for r in rows:
        if now - r["hour"] > digest.RATE_WINDOW_H * 3600:
            continue
        by.setdefault((r["league"], r["cur_a"], r["cur_b"]), []).append(r)
    checked, off = 0, []
    for (lg, a, b), rs in by.items():
        number = digest._fold_rates(rs, now).get((a, b))     # a per b
        series = board._fold_series([{"hour": r["hour"], "rate": r["vol_b"] / r["vol_a"],
                                      "volume_a": r["vol_a"], "volume_b": r["vol_b"]} for r in rs])
        if not number or not series:
            continue
        checked += 1
        if abs(math.log(series[-1]["rate"] * number)) > 1e-9:   # line_end == 1/number
            off.append((lg, a, b, series[-1]["rate"], 1 / number))
    assert checked > 1000, f"only {checked} markets checked — is the production DB populated?"
    assert not off, f"{len(off)} of {checked} lines do not end on their number, e.g. {off[:3]}"
