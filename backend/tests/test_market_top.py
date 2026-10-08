"""Busiest markets (first-contact audit, 2026-10-08): the row carries the market's own realised rate (units of b per
unit of a over the window) so the view shows a rate beside the volume instead of "hours active". The ratio is sent raw (code review: a 4-dp
round lost real digits on rates like 0.000531)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import digest  # noqa: E402


def test_top_markets_valued_carries_the_realised_rate(monkeypatch):
    rows = [{"a": "chaos", "b": "exalted", "volume_a": 24_891_610, "volume_b": 2_347_190, "hours_active": 24},
            {"a": "aug", "b": "exalted", "volume_a": 0, "volume_b": 10, "hours_active": 3}]
    monkeypatch.setattr(digest, "top_markets", lambda league, hours, limit: [dict(r) for r in rows])
    out = digest.top_markets_valued("L", 24, 15, "activity", {"chaos": 10.0, "exalted": 1.0})
    assert out[0]["rate"] == 2_347_190 / 24_891_610, "the raw ratio: the view formats to significant figures"
    assert out[1]["rate"] is None, "no volume on the a side: no rate"
