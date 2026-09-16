"""Notification preferences live in settings.notifications (one object, per family); the legacy
ping_sound/ping_volume keys fold into it once (user migration #4)."""
import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db, migrations_user, settings  # noqa: E402


def test_defaults_banner_on_sound_on_os_off():
    n = settings.DEFAULTS["notifications"]
    assert n == {"volume": 0.15,
                 "live": {"banner": True, "sound": True, "os": False, "tone": "soft1"},
                 "signals": {"banner": True, "sound": True, "os": False, "tone": "alert"}}
    assert "ping_sound" not in settings.DEFAULTS and "ping_volume" not in settings.DEFAULTS


def _conn(tmp_path, stored):
    c = sqlite3.connect(str(tmp_path / "u.sqlite"))
    c.executescript(db.USER_SCHEMA)
    c.execute("INSERT INTO kv(key, value) VALUES('settings', ?)", (json.dumps(stored),))
    return c


def test_m4_folds_legacy_sound_prefs_into_notifications(tmp_path):
    c = _conn(tmp_path, {"ping_sound": False, "ping_volume": 0.2, "league": "L"})
    migrations_user._m4_notifications(c)
    s = json.loads(c.execute("SELECT value FROM kv WHERE key='settings'").fetchone()[0])
    assert s["notifications"] == {"volume": 0.2, "live": {"sound": False}, "signals": {"sound": False}}
    assert "ping_sound" not in s and "ping_volume" not in s and s["league"] == "L"
    migrations_user._m4_notifications(c)                      # idempotent
    assert json.loads(c.execute("SELECT value FROM kv WHERE key='settings'").fetchone()[0]) == s


def test_m4_noop_without_legacy_keys(tmp_path):
    c = _conn(tmp_path, {"league": "L"})
    migrations_user._m4_notifications(c)
    assert json.loads(c.execute("SELECT value FROM kv WHERE key='settings'").fetchone()[0]) == {"league": "L"}
    assert [m[0] for m in migrations_user.USER_MIGRATIONS] == [1, 2, 3, 4]


def test_merged_settings_deep_merge_partial_notifications():
    db.kv_set("settings", {"notifications": {"live": {"os": True}}})
    n = settings.get_settings()["notifications"]
    assert n["live"] == {"banner": True, "sound": True, "os": True, "tone": "soft1"} and n["signals"]["os"] is False
    db.kv_set("settings", {})
