"""The board, Hold and Movers felt slow because SQLite was reading the whole window (owner,
2026-09-19: "the board load, the hold load, and the top movers load ... likely some SQL indexes
would help").

`digest_markets` already carries the index a one-market history wants — `idx_digest_pair
(league, cur_a, cur_b)` — but without ANALYZE statistics SQLite has no idea it is selective, so it
falls back to `idx_digest_league_hour` and walks every row in the window: 314,000 rows, ~50 ms,
for a series of 169. A board card asks two or three of those questions, so eleven cards cost 23
scans and 1.1 s of the board's 1.2 s. With statistics, the same query seeks the pair: ~0.8 ms.

Nothing about WHAT is read changes — same rows, same series, same numbers. Only the path to them.

    python -m pytest backend/tests/test_query_plans.py -q
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db, digest  # noqa: E402
from app.currencies import registry  # noqa: E402

LEAGUE = "PlanLeague"
HOURS = 72
PAIRS = 250


def _fill():
    """A window shaped like the real one: many markets, each with a handful of hours."""
    with db.q() as c:
        if c.execute("SELECT 1 FROM digest_markets WHERE league=? LIMIT 1", (LEAGUE,)).fetchone():
            return
    h0 = (int(time.time()) // 3600) * 3600 - HOURS * 3600
    # one real market (divine<->exalted) buried among many synthetic ones, as it is in the wild
    pairs = [(registry.metas("divine")[0], registry.metas("exalted")[0])]
    pairs += [(f"cur_a{p}", f"cur_b{p}") for p in range(PAIRS)]
    rows = [(h0 + h * 3600, LEAGUE, f"m{p}", a, b, 10, 20,
             None, None, None, None, None, None, None, None)
            for h in range(HOURS) for p, (a, b) in enumerate(pairs)]
    with db.tx() as c:
        c.executemany("INSERT OR REPLACE INTO digest_markets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    db.analyze()


def _plan(sql, params):
    with db.q() as c:
        return " ".join(r["detail"] for r in c.execute("EXPLAIN QUERY PLAN " + sql, params).fetchall())


def test_the_market_db_carries_planner_statistics():
    """Without them every pair query is a full window scan. `db.analyze()` is what puts them
    there, and it must survive a restart (they live in the DB, not in memory)."""
    _fill()
    with db.q() as c:
        stats = c.execute(
            "SELECT stat FROM market.sqlite_stat1 WHERE tbl=? AND idx=?",
            ("digest_markets", "idx_digest_pair_hour")).fetchone()
    assert stats, "market.sqlite has no ANALYZE statistics for the digest's pair index"


def test_one_markets_history_seeks_the_pair_index_instead_of_scanning_the_window():
    """The query `digest.pair_history` runs. It asks for one market's hours; it must not read
    every market's."""
    _fill()
    sql = ("SELECT * FROM digest_markets WHERE league=? AND hour>=? "
           "AND ((cur_a IN (?) AND cur_b IN (?)) OR (cur_a IN (?) AND cur_b IN (?)))")
    plan = _plan(sql, (LEAGUE, 0, "cur_a7", "cur_b7", "cur_b7", "cur_a7"))
    assert "idx_digest_pair_hour" in plan, plan
    assert "idx_digest_league_hour" not in plan, plan


def test_a_markets_history_is_the_same_series_either_way():
    """The point of the index is speed, not a different answer."""
    _fill()
    got = digest.pair_history(LEAGUE, "divine", "exalted", hours=HOURS + 1)
    assert len(got) >= HOURS - 1
    assert all(abs(r["rate"] - 2.0) < 1e-12 for r in got)          # vol_b/vol_a = 20/10
    assert got == sorted(got, key=lambda r: r["hour"])


# ------------------------------------------------------------------ keeping them true
def test_the_background_loop_re_measures_as_the_data_grows(monkeypatch):
    """Statistics taken when the DB was empty are worse than none: they'd claim the pair index
    is useless. The digest loop re-measures after new hours land — never on a request, and not
    more than once an hour."""
    calls = []
    monkeypatch.setattr(db, "analyze", lambda: calls.append(time.time()))
    digest._last_analyze = 0.0
    digest.maybe_analyze(stored=True)
    digest.maybe_analyze(stored=True)          # the next poll, a minute later
    assert len(calls) == 1, "re-measured on every poll"
    digest._last_analyze = time.time() - digest.ANALYZE_EVERY_S - 1
    digest.maybe_analyze(stored=True)
    assert len(calls) == 2, "never re-measured again"
    digest._last_analyze = 0.0
    digest.maybe_analyze(stored=False)         # nothing landed; nothing to re-measure
    assert len(calls) == 2


# ------------------------------------------------------------------ the other shape: a whole window
def test_reading_a_window_of_every_market_is_answered_from_the_index_alone():
    """Hold and Movers card hundreds of assets, so they read the league's whole window at once
    (`digest.window_history`). That genuinely wants every row — but only five of the fifteen
    columns, so the index can carry them and the table need never be touched: 0.43s -> 0.02s on
    the owner's 314,000-row window."""
    _fill()
    plan = _plan("SELECT hour, cur_a, cur_b, vol_a, vol_b FROM digest_markets WHERE league=? AND hour>=?",
                 (LEAGUE, 0))
    assert "COVERING INDEX idx_digest_window" in plan, plan


def test_the_window_holds_exactly_what_the_per_market_queries_hold():
    """Same rows, same rates, whichever index answers: this is a faster path to the same data."""
    _fill()
    one = digest.pair_history(LEAGUE, "divine", "exalted", hours=HOURS + 1)
    many = digest.window_history(LEAGUE, HOURS + 1)("divine", "exalted")
    assert one == many and one


# ------------------------------------------------------------------ moving the guard into SQL
# Both readers skip an hour with no volume on a side (`if not va or not vb`) — it has no rate.
# A fifth of the window is such rows (60,171 of 313,870 on the owner's DB), and reading them only
# to drop them costs ~0.5s of every full-table read. Moving the skip into SQL is allowed ONLY on
# proof that it cannot change an answer — for EVERY market, not a chosen one (owner, 2026-09-19:
# "if you lose data for one and the test doesn't cover it you've just lost data with no recourse").
#
# The proof is a differential over a DB carrying every shape a volume column can take. It was also
# run over the owner's real DB: 933,985 rows / 9,538 markets / 20 leagues, 0 differences.
DIFF_LEAGUE = "DiffLeague"
SHAPES = [(10, 20), (0, 20), (10, 0), (0, 0), (None, 20), (10, None), (None, None),
          (1, 1), (7, 3), (None, 0), (0, None), (999999, 1)]


def _fill_every_shape():
    """250 markets x 60 hours, each hour drawing a different volume shape, so every market sees
    every shape and no market is special."""
    with db.q() as c:
        if c.execute("SELECT 1 FROM digest_markets WHERE league=? LIMIT 1", (DIFF_LEAGUE,)).fetchone():
            return
    h0 = (int(time.time()) // 3600) * 3600 - 60 * 3600
    rows = []
    for p in range(250):
        for h in range(60):
            va, vb = SHAPES[(p + h) % len(SHAPES)]
            rows.append((h0 + h * 3600, DIFF_LEAGUE, f"m{p}", f"a{p}", f"b{p}", va, vb,
                         None, None, None, None, None, None, None, None))
    with db.tx() as c:
        c.executemany("INSERT OR REPLACE INTO digest_markets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    db.analyze()


def _both_paths(league):
    """(today, proposed): the series every market yields when the guard runs in Python over an
    unfiltered read, and when it runs in SQL instead."""
    def build(sql, python_guard):
        out = {}
        with db.q() as c:
            for r in c.execute(sql, (league,)).fetchall():
                va, vb = r["vol_a"], r["vol_b"]
                if python_guard and (not va or not vb):
                    continue
                out.setdefault((r["cur_a"], r["cur_b"]), []).append((r["hour"], vb / va, va, vb))
        return out
    cols = "SELECT hour, cur_a, cur_b, vol_a, vol_b FROM digest_markets WHERE league=?"
    return (build(cols, python_guard=True),
            build(cols + digest.TRADED_ONLY, python_guard=False))


def test_the_sql_guard_is_the_python_guard_for_every_market():
    _fill_every_shape()
    today, proposed = _both_paths(DIFF_LEAGUE)
    assert today, "the differential fixture is empty"
    assert set(today) == set(proposed), "a market appeared or vanished"
    differing = [k for k in today if today[k] != proposed[k]]
    assert not differing, f"{len(differing)} markets read differently, e.g. {differing[:3]}"


def test_the_guard_covers_every_shape_a_volume_column_can_take():
    """If the fixture only ever carried honest volumes the differential would prove nothing."""
    _fill_every_shape()
    with db.q() as c:
        kinds = {(r["vol_a"] is None, r["vol_b"] is None, bool(r["vol_a"]), bool(r["vol_b"]))
                 for r in c.execute("SELECT vol_a, vol_b FROM digest_markets WHERE league=?",
                                    (DIFF_LEAGUE,)).fetchall()}
    assert len(kinds) >= 6, kinds
    dropped = sum(1 for va, vb in SHAPES if not va or not vb)
    assert dropped >= len(SHAPES) // 2, "the fixture barely exercises the guard"


def test_a_market_that_never_traded_yields_nothing_either_way():
    """The case with no recourse: every hour of a market is empty. It must read as no series,
    not as a market that vanished from the DB — its rows are still there."""
    _fill_every_shape()
    h0 = (int(time.time()) // 3600) * 3600 - 5 * 3600
    with db.tx() as c:
        c.executemany("INSERT OR REPLACE INTO digest_markets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      [(h0 + i * 3600, DIFF_LEAGUE, "mdead", "adead", "bdead", 0, None,
                        None, None, None, None, None, None, None, None) for i in range(5)])
    today, proposed = _both_paths(DIFF_LEAGUE)
    assert ("adead", "bdead") not in today and ("adead", "bdead") not in proposed
    with db.q() as c:
        kept = c.execute("SELECT count(*) n FROM digest_markets WHERE cur_a='adead'").fetchone()["n"]
    assert kept == 5, "the rows themselves must remain in the database"


def test_how_much_a_market_traded_is_answered_from_the_index_alone():
    """`digest.pair_volume` sums a league's volumes per market — the volume rule's input, asked
    on every graph build. Carrying the hour and the two volume columns on the pair index turns it
    from 314,000 row lookups into a covering scan: 0.35s -> 0.04s on the owner's DB."""
    _fill()
    plan = _plan("SELECT cur_a, cur_b, SUM(vol_a) va, SUM(vol_b) vb FROM digest_markets "
                 "WHERE league=? AND hour>=? GROUP BY cur_a, cur_b", (LEAGUE, 0))
    assert "COVERING INDEX idx_digest_pair_hour" in plan, plan
