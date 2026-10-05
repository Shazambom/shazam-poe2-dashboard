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
