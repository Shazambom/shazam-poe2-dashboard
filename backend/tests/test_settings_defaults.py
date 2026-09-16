"""settings.DEFAULTS carries the ExiledExchange2 History block (roadmap batch 3)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import settings  # noqa: E402


def test_ee2_history_defaults():
    assert settings.DEFAULTS["ee2History"] == {"enabled": True, "max": 200, "retentionDays": 14}


def test_ee2_history_survives_partial_patch():
    merged = settings._merged({"ee2History": {"max": 50}})
    assert merged["ee2History"] == {"enabled": True, "max": 50, "retentionDays": 14}
