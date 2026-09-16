"""TDD for Phase 3 — the sidecar's DTW league-similarity weights.

Proves `arc.compute_weights` picks out the past league whose price-arc SHAPE most resembles the
current (partial) league, and that the weights are a normalized distribution. Also proves the
stdlib signature reader turns market rows into per-league anchor-currency arcs.

DTW is shape-based, so magnitude/level must NOT decide the winner — a resembling shape at a
different price level should still win over a same-level but differently-shaped league.

Run:  desktop/.venv-sidecar/bin/python -m pytest backend/tests/test_arc.py -q   # needs numpy + dtaidistance
"""
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import marketseries  # noqa: E402
from sidecar.analytics import arc  # noqa: E402


def test_weights_favor_the_resembling_shape_not_the_level():
    # current run: a rising ramp then a dip.
    cur = [1.0, 1.3, 1.6, 1.9, 1.7]
    past = {
        # same SHAPE as cur but shifted to a totally different price level → should win on DTW(z).
        "Resembler": [10.0, 13.0, 16.0, 19.0, 17.0],
        # same starting LEVEL as cur but a falling shape → should lose despite level match.
        "Faller": [1.0, 0.8, 0.6, 0.4, 0.3],
        # flat/noise.
        "Flat": [1.0, 1.02, 0.99, 1.01, 1.0],
    }
    w = arc.compute_weights(cur, past)
    assert set(w) == {"Resembler", "Faller", "Flat"}
    assert abs(sum(w.values()) - 1.0) < 1e-9          # a distribution
    assert w["Resembler"] == max(w.values())          # shape match wins over level match
    assert w["Resembler"] > w["Faller"]


def test_too_short_or_empty_degrades_to_no_weights():
    # An empty/too-short current signal must yield {} so the backend falls back to recency (GAMMA).
    assert arc.compute_weights([], {"A": [1, 2, 3, 4]}) == {}
    assert arc.compute_weights([1.0, 2.0], {"A": [1, 2, 3, 4]}) == {}  # < min_len
    assert arc.compute_weights([1.0, 2.0, 3.0, 4.0], {}) == {}          # no past leagues


def test_league_signatures_reads_anchor_arc_per_league():
    c = sqlite3.connect(":memory:")
    c.execute("CREATE TABLE league_daily (league TEXT, item_id INTEGER, day TEXT, close REAL, "
              "average REAL, volume INTEGER, PRIMARY KEY(league,item_id,day))")
    # anchor = item 291 (Divine). Two leagues, plus a non-anchor row that must be ignored.
    c.executemany("INSERT INTO league_daily VALUES(?,?,?,?,?,?)", [
        ("L1", 291, "2025-01-01", 100.0, 100.0, 5),
        ("L1", 291, "2025-01-02", 110.0, 110.0, 5),
        ("L1", 999, "2025-01-01", 3.0, 3.0, 5),      # different item — ignored
        ("L2", 291, "2025-02-01", 200.0, 200.0, 5),
    ])
    c.commit()
    sigs = marketseries.league_signatures(c, anchor_id=291)
    assert sigs == {"L1": [100.0, 110.0], "L2": [200.0]}


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
