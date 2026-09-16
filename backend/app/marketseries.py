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


def _epoch(day: str) -> int:
    return int(_dt.datetime.strptime(day, "%Y-%m-%d")
               .replace(tzinfo=_dt.timezone.utc).timestamp())


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
