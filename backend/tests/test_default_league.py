"""The default league is the youngest current league (owner, 2026-10-02: "make the default for the
league the youngest one"). A Windows user on 0.3.9 sat on Standard, which has no league history, so
Hold was empty. Youngest = among the leagues poe2scout marks current (`lh_current`, which never holds
Standard or Hardcore), the one whose history starts latest. Only the league dropdown stores a league;
saving any other setting must not bake the default in (it used to store the whole merged blob, so
every install that changed anything kept "Standard"). Migration #7 frees those saved "Standard"s once
(owner chose: move them once; anyone who really plays Standard picks it again and it sticks)."""
import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db, migrations_user, settings  # noqa: E402
from app.config import LEAGUE  # noqa: E402


def _history(rows):
    """rows: {league: first day}; one item, two days each."""
    with db.tx() as c:
        c.execute("DELETE FROM league_daily")
        for lg, day in rows.items():
            for d in (day, day[:-2] + f"{int(day[-2:]) + 1:02d}"):
                c.execute("INSERT INTO league_daily(league, item_id, day, close, average, volume) VALUES (?,?,?,?,?,?)",
                          (lg, 1, d, 1.0, 1.0, 10))


@pytest.fixture(autouse=True)
def clean():
    db.kv_set("settings", {})
    yield
    db.kv_set("settings", {})
    db.kv_set("lh_current", [])
    with db.tx() as c:
        c.execute("DELETE FROM league_daily")
    settings.forget_youngest()


def _set(current, history):
    db.kv_set("lh_current", current)
    _history(history)
    settings.forget_youngest()


def test_youngest_is_the_current_league_whose_history_starts_latest():
    _set(["Runes of Aldur", "Forbidden Rites"],
         {"Runes of Aldur": "2026-05-29", "Forbidden Rites": "2026-09-04", "Fate of the Vaal": "2025-12-12",
          "Standard": "2026-09-20"})
    assert settings.youngest_league() == "Forbidden Rites", "Standard is never current; ended leagues never count"


def test_a_current_league_with_no_history_yet_is_the_youngest():
    _set(["Runes of Aldur", "Brand New"], {"Runes of Aldur": "2026-05-29"})
    assert settings.youngest_league() == "Brand New", "a league that started today has no dailies yet"


def test_nothing_known_falls_back_to_the_configured_league():
    _set([], {"Runes of Aldur": "2026-05-29"})
    assert settings.youngest_league() == LEAGUE


def test_an_unset_league_reads_as_the_youngest_and_a_chosen_one_wins():
    _set(["Runes of Aldur", "Forbidden Rites"], {"Runes of Aldur": "2026-05-29", "Forbidden Rites": "2026-09-04"})
    assert settings.get_settings()["league"] == "Forbidden Rites"
    settings.save_settings({"league": "Runes of Aldur"})
    assert settings.get_settings()["league"] == "Runes of Aldur"
    settings.save_settings({"league": "Standard"})
    assert settings.get_settings()["league"] == "Standard", "Standard picked from the dropdown sticks"


def test_saving_another_setting_never_stores_the_default_league():
    _set(["Forbidden Rites"], {"Forbidden Rites": "2026-09-04"})
    settings.save_settings({"reference": "divine"})
    assert "league" not in db.kv_get("settings", {})
    _set(["Next League"], {"Next League": "2026-12-11"})
    assert settings.get_settings()["league"] == "Next League", "the next league becomes the default without a release"


def _conn(tmp_path, stored):
    c = sqlite3.connect(str(tmp_path / "u.sqlite"))
    c.executescript(db.USER_SCHEMA)
    if stored is not None:
        c.execute("INSERT INTO kv(key, value) VALUES('settings', ?)", (json.dumps(stored),))
    return c


def _stored(c):
    return json.loads(c.execute("SELECT value FROM kv WHERE key='settings'").fetchone()[0])


def test_m7_frees_a_saved_standard_once(tmp_path):
    c = _conn(tmp_path, {"league": "Standard", "reference": "divine"})
    migrations_user._m7_league_default(c)
    assert _stored(c) == {"reference": "divine", "_league_default_v1": True}
    s = _stored(c)
    s["league"] = "Standard"                                   # picked again afterwards
    c.execute("UPDATE kv SET value=? WHERE key='settings'", (json.dumps(s),))
    migrations_user._m7_league_default(c)
    assert _stored(c)["league"] == "Standard", "once only: a later choice of Standard sticks"


def test_m7_keeps_any_other_league_and_tolerates_no_settings(tmp_path):
    c = _conn(tmp_path, {"league": "Runes of Aldur"})
    migrations_user._m7_league_default(c)
    assert _stored(c)["league"] == "Runes of Aldur"
    (tmp_path / "empty").mkdir()
    migrations_user._m7_league_default(_conn(tmp_path / "empty", None))   # an install with no settings row
    assert 7 in [m[0] for m in migrations_user.USER_MIGRATIONS]


def test_retired_saved_league_falls_back_to_youngest_while_active_permanent_and_private_stick():
    """When a league ends (e.g. Forbidden Rites -> Conquerors of Wraeclast), returning users who picked it
    in the dropdown must not stay stranded on a dead league, while Standard / HC / private leagues stick."""
    _set(["Conquerors of Wraeclast"],
         {"Forbidden Rites": "2026-09-04", "Conquerors of Wraeclast": "2026-12-11"})
    # Case 1: trade_leagues from GGG no longer lists Forbidden Rites.
    db.kv_set("trade_leagues", {"at": 9_999_999_999.0, "leagues": [
        {"id": "Conquerors of Wraeclast", "text": "Conquerors of Wraeclast"},
        {"id": "HC Conquerors of Wraeclast", "text": "HC Conquerors of Wraeclast"},
        {"id": "Standard", "text": "Standard"},
        {"id": "Early Access Standard", "text": "Early Access Standard"},
    ]})
    try:
        settings.save_settings({"league": "Forbidden Rites"})
        assert settings.get_settings()["league"] == "Conquerors of Wraeclast"

        settings.save_settings({"league": "Standard"})
        assert settings.get_settings()["league"] == "Standard"

        settings.save_settings({"league": "Early Access Standard"})
        assert settings.get_settings()["league"] == "Early Access Standard"

        settings.save_settings({"league": "HC Conquerors of Wraeclast"})
        assert settings.get_settings()["league"] == "HC Conquerors of Wraeclast"

        settings.save_settings({"league": "Friends (PL99999)"})
        assert settings.get_settings()["league"] == "Friends (PL99999)"

        # Case 2: trade_leagues not fetched yet, but Forbidden Rites is a past league in league_daily
        # and no longer in lh_current.
        db.kv_set("trade_leagues", None)
        settings.save_settings({"league": "Forbidden Rites"})
        assert settings.get_settings()["league"] == "Conquerors of Wraeclast"

        settings.save_settings({"league": "Standard"})
        assert settings.get_settings()["league"] == "Standard"
    finally:
        db.kv_set("trade_leagues", None)


def test_trade_leagues_cache_ttl_is_short_enough_for_launch_day(monkeypatch):
    import asyncio
    from app import gateway, orderbook

    assert orderbook.TRADE_LEAGUES_TTL_S <= 3600
    calls = {"n": 0}

    class _R:
        def raise_for_status(self): pass
        def json(self): return {"result": [{"id": "Conquerors of Wraeclast", "text": "Conquerors of Wraeclast"}]}

    async def fake_req(*a, **k):
        calls["n"] += 1
        return _R()

    monkeypatch.setattr(gateway, "request", fake_req)
    now = 1_800_000_000.0
    monkeypatch.setattr(orderbook.time, "time", lambda: now)
    db.kv_set("trade_leagues", {"at": now - orderbook.TRADE_LEAGUES_TTL_S - 5, "leagues": [{"id": "Old", "text": "Old"}]})
    try:
        out = asyncio.run(orderbook.leagues())
        assert calls["n"] == 1 and out == [{"id": "Conquerors of Wraeclast", "text": "Conquerors of Wraeclast"}]
    finally:
        db.kv_set("trade_leagues", None)


def test_c5_expired_trade_leagues_and_permanent_and_hc_retirement_and_unrelated_save(monkeypatch):
    now = 1_800_000_000.0
    monkeypatch.setattr(settings.time, "time", lambda: now)

    _set(["Conquerors of Wraeclast"],
         {"Dawn of the Hunt": "2025-04-04", "Forbidden Rites": "2026-09-04", "Conquerors of Wraeclast": "2026-12-11"})
    try:
        # 1. Expired trade_leagues must NOT retire a newly current league.
        db.kv_set("trade_leagues", {"at": now - settings.TRADE_LEAGUES_TTL_S - 10, "leagues": [
            {"id": "Forbidden Rites", "text": "Forbidden Rites"},
        ]})
        settings.save_settings({"league": "Conquerors of Wraeclast"})
        assert settings.get_settings()["league"] == "Conquerors of Wraeclast"

        # 2. Fresh trade_leagues omitting a permanent realm must NOT retire Standard / Early Access Standard.
        db.kv_set("trade_leagues", {"at": now - 10, "leagues": [
            {"id": "Conquerors of Wraeclast", "text": "Conquerors of Wraeclast"},
        ]})
        settings.save_settings({"league": "Standard"})
        assert settings.get_settings()["league"] == "Standard"
        settings.save_settings({"league": "Early Access Standard"})
        assert settings.get_settings()["league"] == "Early Access Standard"

        # 3. Retired HC challenge league retires even when trade_leagues is absent.
        db.kv_set("trade_leagues", None)
        settings.save_settings({"league": "HC Dawn of the Hunt"})
        assert settings.get_settings()["league"] == "Conquerors of Wraeclast"

        # 4. Launch-day lag: lh_current still lists ended league while fresh trade_leagues lists the new one.
        _set(["Forbidden Rites"], {"Forbidden Rites": "2026-09-04"})
        db.kv_set("trade_leagues", {"at": now - 5, "leagues": [
            {"id": "Conquerors of Wraeclast", "text": "Conquerors of Wraeclast"},
            {"id": "HC Conquerors of Wraeclast", "text": "HC Conquerors of Wraeclast"},
            {"id": "Standard", "text": "Standard"},
        ]})
        settings.forget_youngest()
        assert settings.youngest_league() == "Conquerors of Wraeclast"

        # 5. Unrelated save_settings patch must not clobber stored league with derived youngest_league,
        # yet still returns the effective (merged) settings.
        db.kv_set("settings", {"league": "Forbidden Rites", "reference": "exalted"})
        out = settings.save_settings({"reference": "divine"})
        assert out["league"] == "Conquerors of Wraeclast"
        assert out["reference"] == "divine"
        assert db.kv_get("settings", {}).get("league") == "Forbidden Rites"
        assert db.kv_get("settings", {}).get("reference") == "divine"

        # 6. orderbook.leagues() storing fresh trade_leagues must invalidate the 5-min youngest_league memo
        # automatically so a retired saved league does not fall back to itself from the stale memo.
        import asyncio
        from app import gateway, orderbook

        db.kv_set("trade_leagues", None)
        _set(["Old League"], {"Old League": "2026-09-04"})
        db.kv_set("settings", {"league": "Old League"})
        assert settings.get_settings()["league"] == "Old League"  # primes the youngest_league memo with "Old League"

        class _R:
            def raise_for_status(self): pass
            def json(self):
                return {"result": [
                    {"id": "Brand New League", "text": "Brand New League"},
                    {"id": "Standard", "text": "Standard"},
                ]}

        async def fake_req(*a, **k):
            return _R()

        monkeypatch.setattr(gateway, "request", fake_req)
        monkeypatch.setattr(orderbook.time, "time", lambda: now)
        asyncio.run(orderbook.leagues(force=True))
        # No manual settings.forget_youngest() here: orderbook.leagues() must have invalidated the memo.
        assert settings.get_settings()["league"] == "Brand New League"

        # 7. An overlapping _youngest_now() that finishes AFTER forget_youngest() must not poison the memo.
        settings.forget_youngest()
        orig_now = settings._youngest_now
        called = {"n": 0}

        def racy_now():
            called["n"] += 1
            if called["n"] == 1:
                settings.forget_youngest()  # simulates orderbook.leagues() invalidating mid-compute
                return "Stale League"
            return "Fresh League"

        monkeypatch.setattr(settings, "_youngest_now", racy_now)
        try:
            assert settings.youngest_league() == "Stale League"
            assert settings.youngest_league() == "Fresh League", "racy compute must not have cached Stale League"
        finally:
            monkeypatch.setattr(settings, "_youngest_now", orig_now)

        # 8. Non-string / blank league IDs in fresh trade_leagues must be ignored cleanly.
        _set(["Conquerors of Wraeclast"], {"Conquerors of Wraeclast": "2026-12-11"})
        db.kv_set("trade_leagues", {"at": now - 5, "leagues": [{"id": 17}, {"id": "   "}, "bad"]})
        settings.forget_youngest()
        assert settings._fresh_trade_league_ids() == []
        settings.save_settings({"league": "Conquerors of Wraeclast"})
        assert settings.get_settings()["league"] == "Conquerors of Wraeclast"
        assert settings.youngest_league() == "Conquerors of Wraeclast"
    finally:
        db.kv_set("trade_leagues", None)
        settings.forget_youngest()


