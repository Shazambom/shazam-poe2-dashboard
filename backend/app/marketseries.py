"""Shared market-series reader — stdlib only, no app imports.

Turns the `league_daily` + `item_meta` market tables into per-item daily series. Deliberately
takes a raw sqlite3 connection so the heavy-analytics SIDECAR (a separate lean binary) can read
the same series the backend uses without importing the FastAPI backend. `movers._current_series`
delegates here; the sidecar calls `series_for_league` with the league the backend chose (passed
in the job params, since only the backend knows the user's selected league).

Column order below matches the SELECTs, so both a Row-factory connection (backend) and a plain
connection (sidecar) index the same by position.
"""
from __future__ import annotations

import datetime as _dt
import sqlite3

# Operational kv key holding the game's currently-live leagues (written by the poe2scout crawl).
CURRENT_LEAGUES_KEY = "lh_current"


def read_meta(conn: sqlite3.Connection) -> dict:
    """{item_id: (name, category)}."""
    return {r[0]: (r[1], r[2]) for r in conn.execute(
        "SELECT item_id, name, category FROM item_meta")}


def read_rows(conn: sqlite3.Connection, league: str | None = None) -> list:
    """Raw (league, item_id, day, close, volume) rows with close>0, ORDER BY league, day.
    Filtered to one league when given (the sidecar path); all leagues otherwise (movers, which
    then picks the league itself)."""
    if league is None:
        return conn.execute(
            "SELECT league, item_id, day, close, volume FROM league_daily "
            "WHERE close>0 ORDER BY league, day").fetchall()
    return conn.execute(
        "SELECT league, item_id, day, close, volume FROM league_daily "
        "WHERE close>0 AND league=? ORDER BY league, day", (league,)).fetchall()


def day_to_epoch(day: str) -> int:
    """UTC epoch seconds for a YYYY-MM-DD day string (the league_daily day key)."""
    return int(_dt.datetime.strptime(day, "%Y-%m-%d")
               .replace(tzinfo=_dt.timezone.utc).timestamp())


_epoch = day_to_epoch


def league_age(day: str, day0: str) -> int:
    """Whole days between two YYYY-MM-DD strings — real day-of-league, gap-proof."""
    return (_dt.date.fromisoformat(day) - _dt.date.fromisoformat(day0)).days


def change_over(pts: list, window_s: float, t=lambda p: p["t"], v=lambda p: p["v"]):
    """(base_point, change_pct) of the last point vs the point at-or-before the window start —
    the ONE definition of "% change over the window" the board, movers and asset detail share.
    Falls back to the first point when the series is shorter than the window; (None, None) with
    fewer than two points; (base, None) on a zero base."""
    if len(pts) < 2:
        return None, None
    start = t(pts[-1]) - window_s
    prior = [p for p in pts if t(p) <= start]
    base = prior[-1] if prior else pts[0]
    if not v(base):
        return base, None
    return base, (v(pts[-1]) - v(base)) / v(base) * 100


def pick_league(rows: list, preferred: str, current_leagues=()) -> str | None:
    """Which league's series to serve: the user's `preferred` if it has data, else the newest
    of the game's currently-live leagues (`current_leagues`, the lh_current kv) that does, else
    the league with the latest first day. `rows` must be ORDER BY league, day."""
    day0s: dict = {}
    for r in rows:
        day0s.setdefault(r[0], r[2])          # first day seen per league = its day-0
    if preferred in day0s:
        return preferred
    cur = set(current_leagues or ())
    return next((l for l in day0s if l in cur), None) or (
        max(day0s, key=lambda l: day0s[l] or "") if day0s else None)


def build_series(rows: list, league: str) -> dict:
    """{item_id: [(t_epoch, close, value_ex)] oldest→newest} for one league. value = close*volume,
    the traded-value measure movers/holdscore already use so thin days can be floored."""
    series: dict = {}
    for r in rows:
        lg, item_id, day, close, volume = r[0], r[1], r[2], r[3], r[4]
        if lg != league:
            continue
        try:
            t = _epoch(day)
        except (ValueError, TypeError):
            continue
        series.setdefault(item_id, []).append((t, close, (volume or 0) * close))
    return series


def series_for_league(conn: sqlite3.Connection, league: str) -> tuple[dict, dict]:
    """Convenience for the sidecar: (series, meta) for one league in one call."""
    rows = read_rows(conn, league)
    return build_series(rows, league), read_meta(conn)


# Divine Orb — the anchor currency whose Exalted price arc IS the league's inflation curve.
# Duplicated from holdscore.DIVINE_ID (the sidecar must not import the backend). See leaguearc.
DIVINE_ID = 291


def item_rows(conn: sqlite3.Connection, item_id: int) -> list:
    """(league, day, close) rows for ONE item across all leagues, close>0, ORDER BY league, day
    (indexed on item_id — cheap even on the full history)."""
    return conn.execute(
        "SELECT league, day, close FROM league_daily WHERE item_id=? AND close>0 ORDER BY league, day",
        (item_id,)).fetchall()


def league_signatures(conn: sqlite3.Connection, anchor_id: int = DIVINE_ID) -> dict:
    """{league: [anchor_close ...] oldest→newest} — each league's price-arc SHAPE signature for
    the Phase-3 DTW league-similarity (arc.compute_weights). The anchor is Divine-in-Exalted, the
    canonical inflation curve; leagues without anchor data simply don't appear."""
    sigs: dict = {}
    for r in item_rows(conn, anchor_id):
        sigs.setdefault(r[0], []).append(r[2])
    return sigs
