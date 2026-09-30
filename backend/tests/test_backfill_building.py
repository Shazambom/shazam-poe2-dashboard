"""The crawl says whether it is BUILDING the install's history (nothing stored yet) or refreshing it,
and how many item fetches it attempted and how many failed.

Audit 2026-09-29 (docs/bugs/2026-09-29-audit-open-items.md, U1): every routine 12-hourly crawl showed
"Building your dashboard" in the header, even on a seeded install with a full board. The header now
says "Refreshing" unless the install holds no history at all (lib/backfillLabel.js); a new league on a
populated install is a refresh too (code review 2026-09-29).

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_backfill_building.py -q
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
sys.path.insert(0, str(Path(__file__).resolve().parent))
from app import db, leaguehistory as lh  # noqa: E402
from test_seedready_sim import crawl, league, run, scout  # noqa: E402,F401  (fixture)


@pytest.fixture
def keeps_lh_current():
    """A crawl records the simulated league as current; later tests expect that key untouched."""
    before = db.kv_get("lh_current")
    yield
    table = db._kv_table("lh_current")
    with db.tx() as c:
        if before is None:
            c.execute(f"DELETE FROM {table} WHERE key='lh_current'")
    if before is not None:
        db.kv_set("lh_current", before)


def _building_during_fetches(monkeypatch, name):
    seen = []
    real = lh.fetch_item

    async def spy(league_name, *a, **k):
        if league_name == name:
            seen.append(lh.progress.get("building"))
        return await real(league_name, *a, **k)
    monkeypatch.setattr(lh, "fetch_item", spy)
    crawl()
    monkeypatch.setattr(lh, "fetch_item", real)
    return seen


def test_an_install_with_no_history_is_being_built(scout, monkeypatch, keeps_lh_current):
    monkeypatch.setattr(lh, "_has_history", lambda: False)
    seen = _building_during_fetches(monkeypatch, league(scout))
    assert seen and all(b is True for b in seen)


def test_a_new_league_on_a_populated_install_is_a_refresh(scout, monkeypatch, keeps_lh_current):
    monkeypatch.setattr(lh, "_has_history", lambda: True)
    seen = _building_during_fetches(monkeypatch, league(scout))   # this league has no rows yet
    assert seen and all(b is False for b in seen)


def test_the_crawl_reports_attempted_and_failed_fetches(scout, keeps_lh_current):
    league(scout)
    scout.fail["/Items/"] = [500] * 200
    res = run(lh.backfill(force=True))
    scout.fail.clear()
    assert res["attempted"] > 0 and res["errors"] == res["attempted"]
