"""Reproductions from the 2026-09-23 review of the past five days' commits.

Each test encodes the behaviour the owner confirmed, over the owner's real market DB (skipped where
it is absent) or over rows shaped exactly like the real digest. Every one of them FAILS on main as
of 2026-09-23; the fix for each is what makes it pass. Nothing here is a preference — each is a
number the app shows or a call it makes.

    cd backend && DATA_DIR="$(mktemp -d)" MARKET_SEED= ../.venv-test/bin/python -m pytest tests/test_review_2026_09_23.py -q
"""
import math
import os
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db, digest, holdscore, marketseries, settings  # noqa: E402
import importlib
board = importlib.import_module("app.arbitrage.board")  # the module, not the package facade function
from app.currencies import registry  # noqa: E402

PROD_DB = Path(os.environ.get(
    "ARBITER_PROD_MARKET_DB",
    Path.home() / "Library/Application Support/Arbiter/data/market.sqlite"))
_prod = pytest.mark.skipif(not PROD_DB.exists(), reason=f"no production market DB at {PROD_DB}")


def _prod_rows(sql, *params):
    con = sqlite3.connect(f"file:{PROD_DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        return con.execute(sql, params).fetchall()
    finally:
        con.close()


def _newest_league():
    """The league with the newest digest hour in the owner's DB."""
    r = _prod_rows("SELECT league, MAX(hour) AS h FROM digest_markets GROUP BY league ORDER BY h DESC LIMIT 1")
    return r[0]["league"], r[0]["h"]


# ============================================================ 1. a card's line ends on its number
# The number folds the last RATE_WINDOW_H (48h) of trades. The line folds the window PLUS 48h of
# warm-up and only trims the OUTPUT, so hours older than the number's window still weigh on the
# line's end. Owner (2026-09-23): both share the number's definition — a 48h sliding window, every
# point the price you'd have read at that hour.

def _series(rows_ago):
    """(hours_ago, vol_a, vol_b) → a `pair_history`-shaped series (b per a), newest last."""
    now = digest._hour(time.time())
    return [{"hour": now - ago * 3600, "rate": vb / va, "volume_a": va, "volume_b": vb}
            for ago, va, vb in sorted(rows_ago, reverse=True)]


def _number(series, now):
    """What the card's headline is built from: `_fold_rates` over the number's own window."""
    rows = [{"hour": p["hour"], "cur_a": "A", "cur_b": "B", "vol_a": p["volume_a"], "vol_b": p["volume_b"]}
            for p in series if now - p["hour"] <= digest.RATE_WINDOW_H * 3600]
    a_per_b = digest._fold_rates(rows, now).get(("A", "B"))
    return (1.0 / a_per_b) if a_per_b else None          # the line is b per a


def test_a_burst_outside_the_numbers_window_cannot_bend_the_line():
    """Production-like: a market that moved 1,000 units an hour at 100 ex two and a half days ago,
    then one unit at 400 just now. The number reads 400 (only that trade is inside 48h). The line
    the card draws under it must end at 400 too, at every window the picker offers."""
    burst = [(ago, 1000, 100_000) for ago in range(50, 71)]       # 100 b per a, 1000 a/h
    series = _series(burst + [(0, 1, 400)])                       # 400 b per a, 1 unit, now
    now = series[-1]["hour"]
    number = _number(series, now)
    assert number == pytest.approx(400.0)
    for window_h in (24, 72, 168):
        hist = board._priced_history("L", window_h, shared=lambda a, b, h: [p for p in series
                                                                             if now - p["hour"] <= h * 3600])
        line = hist("A", "B", window_h)
        assert line, "the line must exist"
        assert line[-1]["rate"] == pytest.approx(number, rel=1e-9), (
            f"{window_h}h: the line ends at {line[-1]['rate']:.4g} under a number of {number:.4g}")


@_prod
def test_production_every_line_ends_on_its_number_when_fed_what_the_board_feeds_it():
    """Over every market of the newest league that traded in the DB's newest hour: feed
    `_priced_history` exactly what `pair_history` feeds it (window + warm-up) and compare the
    line's last point to the number. The existing coherence test pre-trims the rows to the number's
    window before folding, so it compares two folds over the same rows and cannot see this."""
    league, now = _newest_league()
    rows = _prod_rows("SELECT hour, cur_a, cur_b, vol_a, vol_b FROM digest_markets WHERE league=? AND hour>=?"
                      + digest.TRADED_ONLY + " ORDER BY hour", league, now - (168 + board.RATE_WARMUP_H) * 3600)
    by = defaultdict(list)
    for r in rows:
        by[(r["cur_a"], r["cur_b"])].append({"hour": r["hour"], "rate": r["vol_b"] / r["vol_a"],
                                             "volume_a": r["vol_a"], "volume_b": r["vol_b"]})
    checked, off = 0, []
    for (a, b), series in by.items():
        if series[-1]["hour"] != now:
            continue                        # the number's window and the line's newest point coincide
        number = _number(series, now)
        if not number:
            continue
        for window_h in (24, 168):
            hist = board._priced_history(league, window_h, now=now,
                                         shared=lambda _a, _b, h, s=series: [p for p in s if now - p["hour"] <= h * 3600])
            line = hist(a, b, window_h)
            if not line:
                continue
            checked += 1
            if abs(math.log(line[-1]["rate"] / number)) > 1e-9:
                off.append((a, b, window_h, round(line[-1]["rate"], 4), round(number, 4)))
    assert checked > 100, f"only {checked} lines checked — is the production DB populated?"
    assert not off, f"{len(off)} of {checked} lines do not end on their number, e.g. {off[:4]}"


# ============================================================ 2. an empty Hold category is not an empty board
# The dropdown lists every category the day scored; the rows are the eligible board filtered to
# one. A category none of whose assets pass today's gate returns no rows, and the endpoint reads
# "no rows" as "no data" and starts a full poe2scout crawl. Owner (2026-09-23): the dropdown must
# not jump around as the time range changes — keep the list stable and show nothing, never crawl.

def test_an_empty_category_does_not_start_a_crawl(monkeypatch):
    from app import main
    asked = []
    monkeypatch.setattr(main, "_ask_backfill", lambda league: asked.append(league) or True)
    monkeypatch.setattr(main, "_spawn", lambda coro: coro.close())
    monkeypatch.setattr(holdscore, "leaderboard",
                        lambda hz, category, numeraire, k=None: {
                            "assets": [], "categories": ["all", "idol", "omen"], "league": "L",
                            "horizon": hz, "k": 2.0, "pred_shown": False})
    from fastapi.testclient import TestClient
    r = TestClient(main.app).get("/api/hold?category=idol&horizon=3d")
    assert r.status_code == 200
    assert not r.json().get("building"), "a category with nothing eligible is not a missing backfill"
    assert asked == [], "an empty category must not kick the poe2scout crawl"


def _prod_context(num_id=291):
    """The owner's leagues, built exactly as `_build_context` builds them, read-only."""
    rows = [tuple(r) for r in _prod_rows("SELECT league, item_id, day, close, volume FROM league_daily "
                                         "WHERE close > 0 ORDER BY league, item_id, day")]
    metas = {r["item_id"]: (r["name"], r["category"]) for r in _prod_rows(
        "SELECT item_id, name, category FROM item_meta")}
    by_league = defaultdict(list)
    for lg, iid, day, close, vol in rows:
        by_league[lg].append((iid, day, close, vol))
    built, day0 = {}, {}
    for lg, rws in by_league.items():
        built[lg], day0[lg] = holdscore._build_league(rws, num_id)
    cur_name = max(built, key=lambda lg: day0[lg] or "")
    past = sorted(((lg, built[lg]) for lg in built if lg != cur_name), key=lambda x: day0[x[0]] or "", reverse=True)
    return cur_name, built[cur_name], past, metas


@_prod
def test_production_the_category_list_does_not_move_with_the_time_range(monkeypatch):
    """Over the owner's current league: the categories the dropdown offers are the same at 1d, 3d
    and 7d, and a listed category that has no eligible row today is still listed (the owner does
    not want the control to change under them)."""
    from app import currencies, movers
    ctx = _prod_context()
    monkeypatch.setattr(holdscore, "build_context", lambda num_id: ctx)
    monkeypatch.setattr(holdscore, "_arc_weights", lambda name: None)
    monkeypatch.setattr(movers, "exchange_cards", lambda names, hours, num=None: {})
    monkeypatch.setattr(currencies.registry, "resolve_meta", lambda meta_id: "divine")
    lists = {}
    for hz in ("1d", "3d", "7d"):
        b = holdscore._leaderboard(hz, "all", "divine", 291, "Divine Orb", holdscore.CAUTION_K)
        assert b["assets"], f"{hz}: the real league scored nothing?"
        lists[hz] = b["categories"]
    assert lists["1d"] == lists["3d"] == lists["7d"], f"the dropdown moves with the time range: {lists}"


# ============================================================ 3. the forecast never reads before day 0
# `_predict(window=PRED_WINDOW)` reads start days N-5 … N+5. For N < 5 that is a negative day, which
# `_nearest`/`_smooth` resolve to the league's first day — so day 0's return is counted several
# times over for league-days 1-4, in both the forecast and its band.

@_prod
def test_production_the_forecast_never_reads_a_day_before_the_league_began(monkeypatch):
    _cur, _per, past, _meta = _prod_context()
    assert len(past) >= holdscore.MIN_PRED_LEAGUES
    targets = []
    real = holdscore._smooth

    def spy(series, target):
        targets.append(target)
        return real(series, target)
    monkeypatch.setattr(holdscore, "_smooth", spy)
    items = [iid for iid in past[0][1] if all(iid in per for _lg, per in past[:2])][:50]
    assert items, "no item is present in two past leagues?"
    for N in range(1, holdscore.PRED_WINDOW):
        for iid in items:
            holdscore._predict(iid, N, holdscore.HORIZON_DAYS["3d"], past, None, window=holdscore.PRED_WINDOW)
    assert targets, "the forecast read nothing"
    assert min(targets) >= 0, f"the forecast read start day {min(targets)} — before the league began"


# ============================================================ 4. wide_spread cannot mark every market dead
# `hi/lo >= wide` with wide in (0, 1) is true for every market that traded twice. The setting has
# no clamp; the Arbitrage page lets the user type 0.5, and a non-numeric value saved through the
# API makes `float(v)` raise inside every graph build.

def test_wide_spread_below_one_is_not_a_threshold():
    for v in (0.5, 0.99, -3):
        got = settings.wide_spread({"wide_spread": v})
        assert got == 0 or got >= 1.0, f"wide_spread={v} read back as {got}: every market would go inactive"


def test_an_unreadable_wide_spread_falls_back_to_the_default():
    assert settings.wide_spread({"wide_spread": "x"}) == 2.0
    assert settings.wide_spread({"wide_spread": None}) == 2.0


# ============================================================ 5. no single-hour pricing through the setting
# `latest_rates` reads `digest_max_age_h` of rows but `window_rates` is fixed at 48h; a newest hour
# older than 48h has no window price and is priced from that one hour — the very thing 0.3.2
# removed. The window must be at least as wide as the rows it prices.

def _put(league, rows):
    """rows: (hours_ago, cur_a, cur_b, vol_a, vol_b[, hi_stock_a, hi_stock_b]) — the digest's real
    column layout; standing stock defaults to 100 a side."""
    h0 = digest._hour(time.time())
    with db.tx() as c:
        c.execute("DELETE FROM digest_markets WHERE league=?", (league,))
        c.executemany("INSERT OR REPLACE INTO digest_markets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      [(h0 - r[0] * 3600, league, f"{r[1]}|{r[2]}", r[1], r[2], r[3], r[4], None, None,
                        r[5] if len(r) > 5 else 100, r[6] if len(r) > 6 else 100, None, None, None, None)
                       for r in rows])


def test_a_setting_wider_than_the_window_does_not_bring_back_single_hour_pricing():
    dv, ex = registry.metas("divine")[0], registry.metas("exalted")[0]
    league = "ReviewMaxAge"
    # 70h ago the market moved 100 divine at 500 ex each; 60h ago one divine went for 900 ex. The two
    # hours agree within `wide_spread`, so the market is active and its price is its window's.
    _put(league, [(70, dv, ex, 100, 50_000), (60, dv, ex, 1, 900)])
    digest._rate_cache.clear()
    rates = digest.latest_rates(league, max_age_hours=72)
    edge = rates.get(("divine", "exalted"))          # divine -> exalted: exalted per divine
    assert edge, "the market is inside the setting's window; it must be priced"
    ex_per_dv = edge["rate"]
    assert ex_per_dv < 600, f"priced at {ex_per_dv:.0f} ex/div — the one-unit hour alone, not the window"


# ============================================================ 7. two tests that could not fail
# (a) `test_the_market_db_carries_planner_statistics` ran ANALYZE itself before asserting the
#     statistics exist, so the boot path that is supposed to write them was never exercised.
# (b) `test_k_defaults_to_the_setting` compared hold_score(m) to hold_score(m, CAUTION_K) — the
#     `hold_caution` setting the leaderboard falls back to was never read.

def test_boot_writes_the_planner_statistics_a_seeded_install_lacks():
    import test_query_plans as Q
    Q._fill()
    with db.tx() as c:
        c.execute("DELETE FROM market.sqlite_stat1")      # a seed ships without them
    with db.q() as c:
        assert not c.execute("SELECT 1 FROM market.sqlite_stat1 WHERE tbl='digest_markets'").fetchone()
    db._boot_databases()                                   # what a fresh start runs
    with db.q() as c:
        got = c.execute("SELECT idx FROM market.sqlite_stat1 WHERE tbl='digest_markets' AND idx IN "
                        "('idx_digest_window', 'idx_digest_pair_hour')").fetchall()
    assert len(got) == 2, f"boot left the pair/window indexes unmeasured: {got}"


def test_the_leaderboard_falls_back_to_the_hold_caution_setting(monkeypatch):
    seen = {}
    monkeypatch.setattr(holdscore, "get_settings", lambda: {"hold_caution": 3.5, "league": "L"})
    monkeypatch.setattr(holdscore, "_leaderboard",
                        lambda hz, cat, num, num_id, num_name, k: seen.setdefault("k", k) or {"assets": []})
    holdscore._cache.clear()
    holdscore.leaderboard("7d", "all", "divine", None)
    assert seen["k"] == 3.5, f"k=None must read the setting, got {seen}"


# ============================================================ 6. a card carries no bid, ask or spread
# The board used to derive bid and ask from the same window rate via `1/px` and `px` (the round trip
# landed at -7e-15 and the API emitted a negative spread for a market whose sides agree). With the
# bulk-exchange books gone they could never differ, and nothing rendered them; they are cut.

import test_arbitrage_golden as G  # noqa: E402

frozen = G.frozen


def test_a_card_carries_no_bid_ask_or_spread(frozen):
    """Owner (2026-09-23): with the live order books gone the digest gives one window rate both
    ways, so buy == sell and the spread is 0 on every quoted card, and the only market that ever
    made them differ is a dead one's extremes. Nothing renders them. Cut, don't clutter."""
    from app import arbitrage
    G._seed_digest_league()
    arbitrage.invalidate_caches()
    for r in arbitrage.board(24)["rows"]:
        assert not {"buy", "sell", "spread", "spread_pct", "depth"} & set(r), sorted(set(r))


# ============================================================ 6. a card carries no bid, ask or spread
# The board used to derive bid and ask from the same window rate via `1/px` and `px` (the round trip
# landed at -7e-15 and the API emitted a negative spread for a market whose sides agree). With the
# bulk-exchange books gone they could never differ, and nothing rendered them; they are cut.

import test_arbitrage_golden as G  # noqa: E402

frozen = G.frozen


# ============================================================ 8. a wide spread is a question that depth answers
# Owner (2026-09-23): "If there is a wide spread but the order book has some DEPTH then it's a
# valid market; if it's just 1 order on one side and a bunch on the other then it's dead; a bunch
# of orders on both sides with a large spread is likely an active market." Bulk exchange is gone
# for good, so the book is the digest's own standing stock (`hi_stock_*`), and depth is measured
# in hours of the pair's executed volume — scale-free, the same rule for a market that moves ten
# units a day and one that moves a hundred thousand. The spread threshold is the existing
# `wide_spread` setting; the two depth numbers are settings of their own.

def _wide():
    return settings.wide_spread(settings.get_settings())


def _market(stock_a, stock_b, spread_x, va_h, vb_h, a_per_b=100.0):
    """`directed_rates` over an a<->b market whose executed hours ran `spread_x` × the setting
    apart, whose newest hour left `stock_a`/`stock_b` standing, and which moves `va_h`/`vb_h` units
    an hour. `spread_x` > 1 is a wide market, < 1 a steady one."""
    lo, hi = a_per_b, a_per_b * _wide() * spread_x
    r = {"vol_a": int(a_per_b), "vol_b": 1, "hi_stock_a": stock_a, "hi_stock_b": stock_b, "hour": 0,
         "lo_ratio_a": 0, "hi_ratio_a": 0, "lo_ratio_b": 0, "hi_ratio_b": 0}
    return digest.directed_rates("a", "b", r, age=60.0, bounds=(lo, hi), wide_spread=None, rate=a_per_b,
                                 volume=(va_h, vb_h))


def test_one_order_against_forty_is_dead_however_wide():
    out = _market(stock_a=4_000, stock_b=1, spread_x=1.5, va_h=300, vb_h=3)     # 1 b standing = 20 min of trade
    assert out[("a", "b")]["inactive"] is True


def test_depth_on_both_sides_makes_a_wide_market_a_market():
    out = _market(stock_a=2_000, stock_b=20, spread_x=1.5, va_h=100, vb_h=1)    # 20 h standing a side
    assert out[("a", "b")]["inactive"] is False
    assert out[("a", "b")]["rate"] == pytest.approx(1 / 100.0), "an active market is priced at its window rate"


def test_a_steady_market_is_never_asked_about_depth():
    out = _market(stock_a=200, stock_b=2, spread_x=0.75, va_h=100, vb_h=1)      # 2 h a side, spread inside the setting
    assert out[("a", "b")]["inactive"] is False


def test_depth_is_hours_of_the_pairs_own_volume_not_a_unit_count():
    """The same 20 standing units are 20 hours for a market that moves one an hour and 12 minutes
    for one that moves a hundred."""
    slow = _market(stock_a=2_000, stock_b=20, spread_x=1.5, va_h=100, vb_h=1)
    fast = _market(stock_a=2_000, stock_b=20, spread_x=1.5, va_h=10_000, vb_h=100)
    assert slow[("a", "b")]["inactive"] is False
    assert fast[("a", "b")]["inactive"] is True


def test_a_lopsided_book_is_dead_even_when_the_thin_side_covers_an_hour():
    """Both sides clear the hours bar, but one side holds a hundredth of the other (in the same
    units): that is one seller against a wall of buyers, not a market."""
    out = _market(stock_a=100_000, stock_b=2, spread_x=1.5, va_h=100, vb_h=1)  # a-side 1000 h, b-side 2 h; 2 b = 200 a vs 100,000 a
    assert out[("a", "b")]["inactive"] is True


def test_the_depth_bars_are_settings_with_defaults():
    assert settings.depth_hours({}) == 1.0
    assert settings.depth_balance({}) == 0.1
    assert settings.depth_hours({"depth_hours": 3}) == 3.0
    assert settings.depth_balance({"depth_balance": 0.25}) == 0.25


def test_latest_rates_feeds_the_rule_the_pairs_day_of_volume():
    """Wired end to end through the DB: two wide markets, one deep on both sides, one with a
    single unit standing on the thin side. The deep one is priced at its window rate; the thin one
    at its extremes, as today."""
    dv, ex = registry.metas("divine")[0], registry.metas("exalted")[0]
    ch = registry.metas("chaos")[0]
    league = "ReviewDepth"
    steady = [(ago, dv, ex, 100, 50_000, 2_000, 1_000_000) for ago in range(1, 24)]    # 500 ex/div, 100 div/h, 20 h a side
    wide_hour = [(0, dv, ex, 1, 1_500, 2_000, 1_000_000)]                             # one divine at 1,500: 3x
    thin = [(ago, ch, ex, 100, 5_000, 1, 5_000_000) for ago in range(1, 24)] + [(0, ch, ex, 1, 150, 1, 5_000_000)]
    # chaos also trades steadily and far more against divine, so the thin exalted market is not
    # the one that trades it (a currency's busiest market is always a market — section 11)
    busy = [(ago, ch, dv, 5_000, 100, 20_000, 400) for ago in range(0, 24)]           # 50 chaos/div, 250k ex/h
    _put(league, steady + wide_hour + thin + busy)
    digest._rate_cache.clear()
    digest._volume_cache.clear()
    rates = digest.latest_rates(league, max_age_hours=6)
    deep = rates[("divine", "exalted")]
    assert deep["inactive"] is False, "20 hours standing on both sides is a market, whatever one hour printed"
    assert 400 < deep["rate"] < 600, f"priced at {deep['rate']:.0f} ex/div — should be the window's ~500"
    assert rates[("chaos", "exalted")]["inactive"] is True, "one chaos standing against 5M exalted is not a market"


def test_tecrods_gaze_stays_dead_under_the_depth_rule():
    """The market that started all this, from its real hours: 0-9 gazes ever standing against
    thousands of exalted, with the newest hour moving 11 of them. Under the rule it is still dead."""
    import test_inactive_markets as I
    hours = I.FX["hours"]["exalted"]
    traded = [h for h in hours if h["vol_a"] and h["vol_b"]]
    va_h = sum(h["vol_a"] for h in traded) / len(hours)
    vb_h = sum(h["vol_b"] for h in traded) / len(hours)
    px = sorted(h["vol_a"] / h["vol_b"] for h in traded)
    newest = max(hours, key=lambda h: h["hour"])
    out = digest.directed_rates("exalted", "gaze", I._row(**{k: newest[k] for k in ("vol_a", "vol_b", "hi_stock_a", "hi_stock_b")}),
                                age=60.0, bounds=(px[0], px[-1]), wide_spread=None, rate=None, volume=(va_h, vb_h))
    assert out[("exalted", "gaze")]["inactive"] is True


@_prod
def test_production_the_rule_revives_deep_wide_markets_and_no_thin_one():
    """Over the owner's current league: of the markets the spread setting marks dead today, the
    ones standing more than `depth_hours` of their own volume on BOTH sides (and balanced within
    `depth_balance`) come back; every market with a thin side stays dead."""
    league, now = _newest_league()
    rows = _prod_rows("SELECT hour, cur_a, cur_b, vol_a, vol_b, hi_stock_a, hi_stock_b FROM digest_markets "
                      "WHERE league=? AND hour>=?" + digest.TRADED_ONLY + " ORDER BY hour", league, now - 48 * 3600)
    by = defaultdict(list)
    for r in rows:
        by[(r["cur_a"], r["cur_b"])].append(r)
    s = settings.get_settings()
    wide, min_h, min_bal = settings.wide_spread(s), settings.depth_hours(s), settings.depth_balance(s)
    revived, still_dead, wrong = 0, 0, []
    for (a, b), rs in by.items():
        px = [r["vol_a"] / r["vol_b"] for r in rs]
        if max(px) / min(px) < wide:
            continue
        day = [r for r in rs if now - r["hour"] < 24 * 3600]
        va_h, vb_h = sum(r["vol_a"] for r in day) / 24, sum(r["vol_b"] for r in day) / 24
        newest = max(rs, key=lambda r: r["hour"])
        rate = sum(r["vol_a"] for r in rs) / sum(r["vol_b"] for r in rs)
        out = digest.directed_rates(a, b, dict(newest), age=60.0, bounds=(min(px), max(px)), wide_spread=None,
                                    rate=rate, volume=(va_h, vb_h))
        edge = out.get((a, b)) or out.get((b, a))
        if not edge:
            continue
        sa, sb = newest["hi_stock_a"] or 0, newest["hi_stock_b"] or 0
        hours = min(sa / va_h if va_h else 0, sb / vb_h if vb_h else 0)
        bal = min(sa, sb * rate) / max(sa, sb * rate) if max(sa, sb * rate) else 0
        deep = hours >= min_h and bal >= min_bal
        if edge["inactive"] == deep:
            wrong.append((a, b, round(hours, 2), round(bal, 3), edge["inactive"]))
        revived += not edge["inactive"]
        still_dead += edge["inactive"]
    assert revived > 0, "no wide market on the real league is deep on both sides? the rule has no teeth"
    assert still_dead > 0
    assert not wrong, f"{len(wrong)} markets judged against the rule, e.g. {wrong[:4]}"


# ============================================================ 9. a dead market prices the same with or without a neighbour
# The walk refuses a dead market while a live one exists; when nothing else prices the currency
# it falls through `ref_values`, which reads that same dead market at its ASK. So the gaze is
# worth 87.5 ex alone and 3,114 ex once an unrelated market hangs off it.

def test_a_currency_with_only_a_dead_market_is_worth_the_same_with_or_without_an_orphan_neighbour(monkeypatch):
    import test_inactive_markets as I
    from app import leaguehistory
    monkeypatch.setattr(leaguehistory, "scout_prices", lambda league: {})
    hubs = [("divine", "exalted", 471.0, 5_000, False), ("exalted", "divine", 1 / 471.0, 2_400_000, False)]
    dead = [("gaze", "exalted", 87.5, 1.4, True), ("exalted", "gaze", 1 / 3114.0, 3_501, True)]
    orphan = [("gaze", "x", 1.0, 5, False), ("x", "gaze", 1.0, 5, False)]     # x has no other market
    alone = I._graph(hubs + dead).values()["gaze"]
    beside = I._graph(hubs + dead + orphan).values()["gaze"]
    assert alone == pytest.approx(87.5), "alone, the walk prices the gaze at the dead market's bid"
    assert beside == pytest.approx(alone), f"an unrelated market moved the gaze from {alone} to {beside}"


# ============================================================ 10. the line ends at the current hour
# Owner (2026-09-23): the line's last point is the price you'd read NOW — the same 48h fold the
# number is — so it ends on the number for every market, not only the ones that traded this hour.
# Measured before: 1,515 markets that traded in the newest hour matched exactly; of the 1,005
# whose last trade was older, 15% were off by more than 1% and the worst by 242%.

def test_a_market_that_last_traded_yesterday_still_ends_its_line_on_todays_number():
    burst = [(ago, 1000, 100_000) for ago in range(60, 71)]       # 100 b per a, 60-70h ago
    series = _series(burst + [(20, 1, 400)])                      # one unit at 400, 20h ago; nothing since
    now = digest._hour(time.time())
    number = _number(series, now)
    assert number == pytest.approx(400.0), "only the 20h-old trade is inside the number's 48h"
    hist = board._priced_history("L", 24, shared=lambda a, b, h: [p for p in series if now - p["hour"] <= h * 3600], now=now)
    line = hist("A", "B", 24)
    assert line[-1]["hour"] == now, "the line must reach the current hour"
    assert line[-1]["rate"] == pytest.approx(number, rel=1e-9)
    assert len(line) >= 2, "a quiet market draws a flat line to the right edge, not a dot"


@_prod
def test_production_every_line_ends_on_its_number_stale_markets_included():
    league, now = _newest_league()
    rows = _prod_rows("SELECT hour, cur_a, cur_b, vol_a, vol_b FROM digest_markets WHERE league=? AND hour>=?"
                      + digest.TRADED_ONLY + " ORDER BY hour", league, now - (168 + board.RATE_WARMUP_H) * 3600)
    by = defaultdict(list)
    for r in rows:
        by[(r["cur_a"], r["cur_b"])].append({"hour": r["hour"], "rate": r["vol_b"] / r["vol_a"],
                                             "volume_a": r["vol_a"], "volume_b": r["vol_b"]})
    checked, stale, off = 0, 0, []
    for (a, b), series in by.items():
        number = _number(series, now)
        if not number:
            continue
        for window_h in (24, 168):
            hist = board._priced_history(league, window_h, now=now,
                                         shared=lambda _a, _b, h, s=series: [p for p in s if now - p["hour"] <= h * 3600])
            line = hist(a, b, window_h)
            if not line:
                continue
            checked += 1
            stale += series[-1]["hour"] != now
            if line[-1]["hour"] != now or abs(math.log(line[-1]["rate"] / number)) > 1e-9:
                off.append((a.split("/")[-1], b.split("/")[-1], window_h, round(line[-1]["rate"], 4), round(number, 4)))
    assert checked > 1000 and stale > 100, f"{checked} lines, {stale} stale — is the production DB populated?"
    assert not off, f"{len(off)} of {checked} lines do not end on their number, e.g. {off[:4]}"


# ============================================================ 11. a currency's busiest market is a market
# Owner (2026-09-23), on Ulaman's Gaze reading 44.66 ex under a line ending at 202: "The highest
# volume market for any currency by default should be valid. Because that's the market that is
# actually trading that currency." Volume in VALUE (reference units a day), so a market moving 374
# chaos outranks one moving 8,333 exalted only if the chaos is worth more — it is (23,400 vs 8,300).

def _prod_copy(currencies, hours=48):
    """Replay the owner's real digest rows for `currencies` (plus the three hubs) into the test DB."""
    league, now = _newest_league()
    ids = [registry.metas(c)[0] for c in ("exalted", "divine", "chaos")] + list(currencies)
    marks = ",".join("?" * len(ids))
    rows = _prod_rows(f"SELECT * FROM digest_markets WHERE league=? AND hour>=? AND cur_a IN ({marks}) AND cur_b IN ({marks})",
                      league, now - hours * 3600, *ids, *ids)
    shift = digest._hour(time.time()) - now                    # land the rows at the clock's newest hour
    with db.tx() as c:
        c.execute("DELETE FROM digest_markets WHERE league=?", ("ProdCopy",))
        c.executemany("INSERT OR REPLACE INTO digest_markets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      [(r["hour"] + shift, "ProdCopy", r["market_id"], *[r[k] for k in (
                          "cur_a", "cur_b", "vol_a", "vol_b", "lo_stock_a", "lo_stock_b", "hi_stock_a", "hi_stock_b",
                          "lo_ratio_a", "lo_ratio_b", "hi_ratio_a", "hi_ratio_b")]) for r in rows])
    return "ProdCopy", len(rows)


# ============================================================ 11 (cont). the rule lives in the volume rule
# Owner (2026-09-23): the busiest market is the one with the most HUB-STYLE FLOW — units sold per
# hour times the app's one value for the currency sold, both directions of the market summed,
# minus the gold the exchange charges to receive those units (fee per unit, valued through the
# gold setting). That is `counterparts_by_volume`, THE volume rule, which the Board's default
# numeraire and the league arc already walk; the value table reads the same ranking, so a
# currency's busiest market is always quoted whatever its spread says.

def _edge(a, b, rate, vol, inactive=False, quoted=None):
    from app.arbitrage import Edge
    return Edge(a, b, "digest", rate, [{"rate": rate, "stock": 1_000_000}], age_s=0.0, vol_in_per_h=vol,
                meta={"inactive": inactive, "quoted_rate": rate if quoted is None else quoted})


def _flow_graph(fees=None, gold_per_1k=0.0):
    from app.arbitrage import Graph
    g = Graph({"reference": "exalted", "league": "L", "gold_value_per_1k": gold_per_1k, "max_steps": 3, "filters": {}})
    g.fee_table = fees or {}
    for e in (_edge("divine", "exalted", 500.0, 1_000), _edge("exalted", "divine", 1 / 500.0, 500_000),
              _edge("chaos", "exalted", 60.0, 10_000), _edge("exalted", "chaos", 1 / 60.0, 600_000)):
        g.add(e)
    return g


def test_the_volume_rule_is_one_function_shared_by_the_board_the_arc_and_the_value_table():
    from app.arbitrage import graph as G
    assert board.counterparts_by_volume is G.counterparts_by_volume       # `board` is the module (top of file)


def test_the_volume_rule_counts_units_of_the_currency_both_ways():
    """Owner (2026-09-23): the busiest market for a currency is the one that moves the most UNITS
    of it — the omen's chaos market if the most omens trade there, the flux's exalted market
    because five times the flux moves there even though chaos and divine pay 10-20x more per
    unit. Units both ways: what it sold plus what the other side's sales bought."""
    from app.arbitrage import graph as G
    g = _flow_graph()
    # Thaumaturgic Flux (Level 15), from the real digest: exalted 1.3 flux/h at ~25 ex, chaos
    # 0.2/h at ~300 ex, divine 0.1/h at ~500 ex.
    g.add(_edge("x", "exalted", 25.0, 1.0)); g.add(_edge("exalted", "x", 1 / 25.0, 7.5))      # 1.0 + 7.5/25 = 1.3 x/h
    g.add(_edge("x", "chaos", 5.0, 0.15)); g.add(_edge("chaos", "x", 1 / 5.0, 0.25))          # 0.15 + 0.05 = 0.2
    g.add(_edge("x", "divine", 1.0, 0.05)); g.add(_edge("divine", "x", 1.0, 0.05))            # 0.1
    rv = {"exalted": 1.0, "divine": 500.0, "chaos": 60.0, "x": 25.0}
    ranked = G.counterparts_by_volume(g, rv)
    assert [o for _u, o in ranked["x"]] == ["exalted", "chaos", "divine"]
    assert dict((o, round(u, 2)) for u, o in ranked["x"]) == {"exalted": 1.3, "chaos": 0.2, "divine": 0.1}
    # and it is NOT value: by value the divine market (0.1 x 500 + 0.05 x 500 = 50 ex/h) would beat
    # exalted (1.0 x 25 + 7.5 = 32.5 ex/h)


def test_the_volume_rule_is_blind_to_gold_and_to_the_currencys_own_value():
    """Gold charged in item units needs the item's value, which is exactly what is unreliable in
    the cases that matter (the flux valued at a bad 1.0 close would owe 246 flux an hour of
    gold). Owner: gold stays out of the pick; the pick does not move with `rv` at all."""
    from app.arbitrage import graph as G
    fees = {"exalted": 120, "chaos": 160, "divine": 800, "x": 1000}
    g = _flow_graph(fees=fees, gold_per_1k=0.01)
    g.add(_edge("x", "exalted", 25.0, 1.0)); g.add(_edge("exalted", "x", 1 / 25.0, 7.5))
    g.add(_edge("x", "divine", 1.0, 0.05)); g.add(_edge("divine", "x", 1.0, 0.05))
    for rvx in (1.0, 25.0, 5000.0):
        ranked = G.counterparts_by_volume(g, {"exalted": 1.0, "divine": 500.0, "chaos": 60.0, "x": rvx})
        assert [o for _u, o in ranked["x"]] == ["exalted", "divine"], f"rv[x]={rvx} moved the pick"


def test_a_currencys_busiest_market_is_quoted_whatever_its_spread(monkeypatch):
    """X has two dead markets. Its chaos one is the busiest by the volume rule, so the value table
    quotes it at its window rate; the exalted one stays at its extremes. Priced through chaos."""
    from app import leaguehistory
    monkeypatch.setattr(leaguehistory, "scout_prices", lambda league: {})
    g = _flow_graph()
    # chaos market: window 1.6 chaos per x; dead, so the edges carry the extremes (buy dear, sell cheap)
    g.add(_edge("x", "chaos", 0.5, 20, inactive=True, quoted=1.6)); g.add(_edge("chaos", "x", 1 / 5.0, 40, inactive=True, quoted=1 / 1.6))
    # exalted market: thinner; window 100 ex per x
    g.add(_edge("x", "exalted", 30.0, 2, inactive=True, quoted=100.0)); g.add(_edge("exalted", "x", 1 / 300.0, 150, inactive=True, quoted=1 / 100.0))
    g.quote_busiest_markets()
    assert g.edges[("x", "chaos")].meta["inactive"] is False and g.edges[("x", "chaos")].rate == pytest.approx(1.6)
    assert g.edges[("chaos", "x")].rate == pytest.approx(1 / 1.6)
    assert g.edges[("x", "exalted")].meta["inactive"] is True and g.edges[("x", "exalted")].rate == pytest.approx(30.0)
    assert g.values()["x"] == pytest.approx(1.6 * 60.0)
    assert g.priced_by["x"] == "chaos"


def _built(league, monkeypatch):
    """`Graph.build` over the test DB's digest, live books and poe2scout empty, no gold fees."""
    from app import gamedata, leaguehistory, orderbook
    from app.arbitrage import Graph
    monkeypatch.setattr(orderbook, "latest_books", lambda league, max_age_s: {})
    monkeypatch.setattr(leaguehistory, "scout_prices", lambda league: {})
    monkeypatch.setattr(gamedata, "fees", lambda: {"by_trade": {}})
    s = {**settings.DEFAULTS, "league": league, "reference": "exalted", "allow_digest_edges": True,
         "allow_recipe_edges": False, "min_edge_depth": 0, "min_edge_volume_ref_per_h": 0, "hub_count": 2}
    db.kv_set("settings", s)                       # Graph.build reads the saved settings
    digest._rate_cache.clear(); digest._volume_cache.clear()
    try:
        return Graph.build()
    finally:
        db.kv_set("settings", {})


def test_built_from_the_digest_the_busiest_dead_market_prices_the_currency(monkeypatch):
    dv, ex, ch = (registry.metas(c)[0] for c in ("divine", "exalted", "chaos"))
    g_id = registry.metas("vaal")[0]
    league = "ReviewBusiestBuild"
    hubs = [(ago, dv, ex, 100, 50_000, 1000, 500_000) for ago in range(0, 24)] + \
           [(ago, ch, ex, 1000, 60_000, 5000, 300_000) for ago in range(0, 24)]
    ex_mkt = [(ago, g_id, ex, 3, 300 if ago % 2 else 60, 20, 0) for ago in range(0, 24)]      # 5x wide, 3 vaal/h
    ch_mkt = [(ago, g_id, ch, 10, 20 if ago % 2 else 4, 50, 0) for ago in range(0, 24)]       # 5x wide, 10 vaal/h
    _put(league, hubs + ex_mkt + ch_mkt)
    g = _built(league, monkeypatch)
    chaos = g.edges.get(("vaal", "chaos")) or g.edges.get(("chaos", "vaal"))
    exalted = g.edges.get(("vaal", "exalted")) or g.edges.get(("exalted", "vaal"))
    assert chaos and exalted
    assert chaos.meta["inactive"] is False, "the market that trades the currency is quoted"
    assert exalted.meta["inactive"] is True, "the quieter dead market stays dead"
    values = g.values()                                              # builds priced_by with it
    assert g.priced_by["vaal"] == "chaos"
    window = digest.window_rates(league)[(g_id, ch)]                 # vaal per chaos
    assert values["vaal"] == pytest.approx(values["chaos"] / window, rel=1e-9)


def test_a_currency_whose_only_market_wanders_is_still_priced_by_it(monkeypatch):
    """The rule's plain consequence, pinned so nobody is surprised by it: a currency with ONE
    market is priced at that market's window rate however far its hours disagree — it is the
    market trading it. The extreme pricing of 2026-09-19 now applies to secondary markets only."""
    dv, ex = registry.metas("divine")[0], registry.metas("exalted")[0]
    league = "ReviewOnlyMarket"
    _put(league, [(h, dv, ex, 1, 400) for h in range(1, 30)] + [(0, dv, ex, 1, 4)])   # a 100x hour
    g = _built(league, monkeypatch)
    assert g.edges[("divine", "exalted")].meta["inactive"] is False
    assert 300 < g.values()["divine"] < 400, f"priced at {g.values()['divine']:.1f} ex — the window, not the 4-ex hour"


@_prod
def test_production_ulamans_gaze_is_priced_by_its_chaos_market(monkeypatch):
    """The real rows: every Ulaman's Gaze market is wide; the value table prices the gaze through
    its busiest one (the volume rule; chaos on 2026-09-23, exalted two days later — the market
    moves, the rule does not) at that market's window rate, so the number the card shows and the
    line it draws agree."""
    G = "Metadata/Items/SoulCores/UlamansGaze"
    registry._link(G, "ulamans-gaze")            # the test registry has no seed for soul cores
    league, n = _prod_copy([G])
    assert n > 50, f"only {n} rows copied — is the gaze still trading?"
    g = _built(league, monkeypatch)
    values = g.values()
    hub = g.busiest.get("ulamans-gaze")
    assert hub in ("chaos", "exalted", "divine"), hub
    assert g.priced_by.get("ulamans-gaze") == hub, (g.priced_by.get("ulamans-gaze"), hub)
    e = g.edges.get(("ulamans-gaze", hub)) or g.edges.get((hub, "ulamans-gaze"))
    assert e and e.meta["inactive"] is False
    window = digest.window_rates(league).get((G, registry.metas(hub)[0]))
    assert window, f"no {hub} window rate?"
    assert values["ulamans-gaze"] == pytest.approx(values[hub] / window, rel=1e-9)


# ============================================================ 12. poe2scout cannot veto the busiest market
# `believable` rejects a market more than OUTSIDE_DISAGREEMENT (10x) from poe2scout's close, and a
# currency none of whose markets survived is then priced FROM that close: Thaumaturgic Flux
# (Level 15) read 1.00 ex (today's close; 245 yesterday) under a line at 25.7 from an exalted
# market that traded 49 of 72 hours; Artificer's Shard read 59 ex over a line at 0.8. 23 cards.
# Owner (2026-09-23): the busiest market wins; poe2scout still checks secondary markets and prices
# what has no market at all.

def test_the_busiest_market_prices_its_currency_whatever_poe2scout_says(monkeypatch):
    from app import leaguehistory
    monkeypatch.setattr(leaguehistory, "scout_prices", lambda league: {"vaal": 1.0})     # 25x from the market
    g = _flow_graph()
    g.add(_edge("vaal", "exalted", 25.7, 1.0)); g.add(_edge("exalted", "vaal", 1 / 25.7, 7.5))
    g.quote_busiest_markets()
    assert g.values()["vaal"] == pytest.approx(25.7)
    assert g.priced_by["vaal"] == "exalted"


def test_poe2scout_still_vetoes_a_secondary_market(monkeypatch):
    """annul's busiest market is chaos at ~100 ex; its thin exalted market claims 5,000. poe2scout says
    90. The walk reaches annul from exalted first (the reference) and must refuse that claim, then
    price annul through chaos."""
    from app import leaguehistory
    monkeypatch.setattr(leaguehistory, "scout_prices", lambda league: {"annul": 90.0})
    g = _flow_graph()
    g.add(_edge("annul", "chaos", 1 / 0.6, 10.0)); g.add(_edge("chaos", "annul", 0.6, 16.0))          # ~100 ex, 10 + 9.6 y/h
    g.add(_edge("annul", "exalted", 5000.0, 0.5)); g.add(_edge("exalted", "annul", 1 / 5000.0, 2500.0))  # 5,000 ex, 0.5 + 0.5 y/h
    g.quote_busiest_markets()
    assert g.values()["annul"] == pytest.approx(100.0)
    assert g.priced_by["annul"] == "chaos", g.priced_by


def test_a_currency_with_no_market_is_still_priced_from_poe2scout(monkeypatch):
    from app import leaguehistory
    monkeypatch.setattr(leaguehistory, "scout_prices", lambda league: {"regal": 42.0})
    g = _flow_graph()
    g.quote_busiest_markets()
    assert g.values()["regal"] == pytest.approx(42.0)


@_prod
@pytest.mark.parametrize("meta, tid, close", [
    ("Metadata/Items/Currency/CurrencySetKalguuranSkillGemLevel15", "thaumaturgic-flux-15", 1.0),
    ("Metadata/Items/Currency/CurrencyAddEquipmentSocketShard", "artificers-shard", 59.464),
])
def test_production_the_close_does_not_override_the_market_that_trades_it(monkeypatch, meta, tid, close):
    """The real rows for the two worst cards of 2026-09-23, with the poe2scout close that broke
    them: each is priced through its exalted market at that market's window rate."""
    from app import leaguehistory
    registry._link(meta, tid)
    league, n = _prod_copy([meta])
    assert n > 20, f"only {n} rows — is it still trading?"
    name = str(registry.name(tid)).lower()
    g = _built(league, monkeypatch)
    monkeypatch.setattr(leaguehistory, "scout_prices", lambda league: {name: close, tid: close})
    g._values, g.priced_by = None, {}
    values = g.values()
    assert g.priced_by.get(tid) == "exalted", g.priced_by.get(tid)
    ex = registry.metas("exalted")[0]
    rates = digest.window_rates(league)
    ex_per_unit = (1 / rates[(meta, ex)]) if (meta, ex) in rates else rates.get((ex, meta))   # either orientation
    assert ex_per_unit, "no exalted window rate?"
    assert values[tid] == pytest.approx(ex_per_unit, rel=1e-9), f"{values[tid]} vs the close {close}"


# ============================================================ 13. cleanup the review found worth doing

def test_the_graph_never_reads_the_bulk_exchange_books(monkeypatch):
    """The Bulk Item Exchange is gone for good (owner, 2026-09-23). The graph's live-edge path was
    dead code with two latent bugs (a live edge carried no `inactive` flag; the bait filter was
    judged against a dead market's extreme). Building must not even ask for the books."""
    from app import orderbook
    from app.arbitrage import graph as G_
    def boom(*a, **k):
        raise AssertionError("Graph.build asked orderbook for live books")
    monkeypatch.setattr(orderbook, "latest_books", boom)
    dv, ex = registry.metas("divine")[0], registry.metas("exalted")[0]
    _put("ReviewNoBooks", [(h, dv, ex, 100, 50_000) for h in range(0, 6)])
    g = _built("ReviewNoBooks", monkeypatch)
    assert g.edges[("divine", "exalted")].kind == "digest"
    assert not hasattr(G_, "credible_offers") and not hasattr(G_, "BAIT_FACTOR")


def test_graph_py_carries_no_dead_definitions():
    import inspect
    from app.arbitrage import graph as G_
    src = inspect.getsource(G_)
    assert src.count("def _scout_values") == 1, "_scout_values is defined twice; the second silently wins"
    assert "_floor_values" not in src, "_floor_values is unreachable"


# ============================================================ 14. the routes stream reports itself on beta
# Owner (2026-09-23, on 0.3.4-beta.2): "my arbitrage page is jumping between a few offerings and
# many." Not reproducible on a copy of the data (deterministic values and routes; cold search
# 0.8 s; cache-drift moves the loop count a few percent). Stable is blind, so the beta build
# says, through the one telemetry gate, what every search returned and what it was sized from.

def _tlog_capture(monkeypatch):
    import threading
    from app import devtelemetry
    got = []
    monkeypatch.setattr(devtelemetry, "tlog", lambda tag, msg: got.append((tag, msg)))
    def drain():
        for t in threading.enumerate():
            if t is not threading.current_thread():
                t.join(2)
        return got
    return drain


def test_every_route_search_posts_one_diagnostic_line(frozen, monkeypatch):
    from app import arbitrage
    drain = _tlog_capture(monkeypatch)
    g = G._synthetic_graph()
    monkeypatch.setattr(arbitrage.graph, "cached_graph", lambda: g)
    monkeypatch.setattr(arbitrage, "cached_graph", lambda: g)
    arbitrage._route_cache.clear()
    events = list(arbitrage.stream_routes({}, None))
    done = events[-1][1]
    got = [m for t, m in drain() if t == "routes"]
    assert len(got) == 1, got
    line = got[0]
    for key in ("cached=False", f"routes={len(done['order'])}", f"after_filters={done['total_after_filters']}",
                f"candidates={done['total_candidates']}", "ms=", "notional=", "starts="):
        assert key in line, f"{key!r} missing from {line!r}"
    # served from cache: still one line, marked as such
    list(arbitrage.stream_routes({}, None))
    got = [m for t, m in drain() if t == "routes"]
    assert len(got) == 2 and "cached=True" in got[1], got
