"""Hold answers for the league the user is on now (bug report FY0M4R, 2026-10-02): a Windows user on
Standard (no league history) saw an empty Hold page, switched to their league, and Hold stayed empty.
The leaderboard cache was keyed by horizon/category/numeraire/caution only, and a settings save does
not clear it, so the empty Standard answer was served for its 10-minute TTL after the switch."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import cache, db, holdscore, settings  # noqa: E402


def test_switching_league_is_not_served_the_old_leagues_cached_board(monkeypatch):
    built = []

    def fake(horizon, category, numeraire, num_id, num_name, k):
        lg = settings.get_settings()["league"]
        built.append(lg)
        return {"league": lg, "assets": [] if lg == "Standard" else [{"name": "Divine Orb"}]}

    monkeypatch.setattr(holdscore, "_leaderboard", fake)
    cache.clear(holdscore._cache)
    try:
        db.kv_set("settings", {"league": "Standard"})
        assert holdscore.leaderboard("1d")["assets"] == []
        db.kv_set("settings", {"league": "Forbidden Rites"})
        res = holdscore.leaderboard("1d")
        assert res["league"] == "Forbidden Rites" and res["assets"], "the new league's board, not the cached empty one"
        holdscore.leaderboard("1d")
        assert built == ["Standard", "Forbidden Rites"], "still cached within one league"
    finally:
        cache.clear(holdscore._cache)
        db.kv_set("settings", {})
