"""settings.DEFAULTS: the ExiledExchange2 History block (roadmap batch 3) and the custom-theme list."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import settings  # noqa: E402


def test_ee2_history_defaults():
    assert settings.DEFAULTS["ee2History"] == {"enabled": True, "max": 200, "retentionDays": 14}


def test_ee2_history_survives_partial_patch():
    merged = settings._merged({"ee2History": {"max": 50}})
    assert merged["ee2History"] == {"enabled": True, "max": 50, "retentionDays": 14}


def test_custom_themes_default_and_replace_wholesale():
    assert settings.DEFAULTS["custom_themes"] == []
    assert settings.DEFAULTS["theme"] == "vault"
    row = {"id": "custom-0badf00d", "name": "Mine", "base": "ash", "colors": {"--bg": "#000000"}}
    merged = settings._merged({"custom_themes": [row], "theme": "custom-0badf00d"})
    assert merged["custom_themes"] == [row]
    assert merged["theme"] == "custom-0badf00d"
    # Lists are not deep-merged: saving [] clears the themes rather than keeping stale rows.
    merged2 = settings._merged({"custom_themes": []})
    assert merged2["custom_themes"] == []
