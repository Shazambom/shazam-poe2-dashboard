"""TDD for Phase 6 — the shared, stdlib-only market series reader.

`app.marketseries` is the single place that turns the `league_daily` / `item_meta` market
tables into per-item daily series. It imports NO app modules and takes a raw sqlite3 connection,
so the lean analytics sidecar can read the same series the backend's movers view uses without
dragging the FastAPI backend into its binary. `movers._current_series` delegates to it.

Built against a hand-rolled sqlite DB (no app.db boot) to prove the standalone sidecar path.

Run:  python -m pytest backend/tests/test_marketseries.py -q
"""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import marketseries  # noqa: E402


def _db():
    c = sqlite3.connect(":memory:")
    c.executescript("""
        CREATE TABLE item_meta (item_id INTEGER PRIMARY KEY, name TEXT, category TEXT);
        CREATE TABLE league_daily (league TEXT, item_id INTEGER, day TEXT, close REAL,
                                   average REAL, volume INTEGER, PRIMARY KEY(league,item_id,day));
    """)
    c.executemany("INSERT INTO item_meta VALUES(?,?,?)",
                  [(1, "Divine Orb", "currency"), (2, "Chaos Orb", "currency")])
    rows = [
        ("Old",  1, "2026-08-01", 5.0, 5.0, 10),
        ("Std",  1, "2026-09-01", 10.0, 10.0, 100),
        ("Std",  1, "2026-09-02", 11.0, 11.0, 200),
        ("Std",  2, "2026-09-01", 1.0, 1.0, 50),
        ("Std",  2, "2026-09-02", 0.0, 0.0, 999),   # close<=0 must be dropped
    ]
    c.executemany("INSERT INTO league_daily VALUES(?,?,?,?,?,?)", rows)
    c.commit()
    return c


def test_series_for_league_shapes_points():
    c = _db()
    series, meta = marketseries.series_for_league(c, "Std")
    assert meta[1] == ("Divine Orb", "currency")
    # item 1: two points oldest->newest, value = close*volume
    pts = series[1]
    assert [round(v, 2) for (_t, _close, v) in pts] == [1000.0, 2200.0]
    assert pts[0][0] < pts[1][0]                     # epoch ascending
    # item 2: the close<=0 day is filtered, leaving one point
    assert len(series[2]) == 1
    # 'Old' league rows never leak into 'Std'
    assert all(len(p) == 3 for p in series[1])


def test_pick_league_serves_the_selected_league_or_nothing():
    """No silent fallback: a league with no stored data serves nothing rather than quietly
    answering about a different economy than the Board (owner directive 2026-09-19)."""
    c = _db()
    rows = marketseries.read_rows(c)                 # all leagues, ORDER BY league, day
    assert marketseries.pick_league(rows, "Std", []) == "Std"
    assert marketseries.pick_league(rows, "Nope", current_leagues=["Std"]) is None
    assert marketseries.pick_league(rows, "Nope", current_leagues=[]) is None


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
