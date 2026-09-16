"""TDD for Phase 4 — signal acknowledgement (dismissals).

A signal's identity is (item_id, spike-day t) — stable across the sidecar's periodic recompute, so a
dismissal sticks while the same signal keeps re-firing, and naturally lapses once the spike ages out
of the recent window. These pure helpers back /api/signals (annotate + unseen count) and
/api/signals/ack (merge), with self-pruning so the ack set can't grow without bound.

Run:  .venv-test/bin/python -m pytest backend/tests/test_signalsack.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import signalsack  # noqa: E402

SIGS = [{"item_id": 1, "t": 100, "name": "A"}, {"item_id": 2, "t": 200, "name": "B"}]


def test_key_is_item_and_time():
    assert signalsack.sig_key(SIGS[0]) == "1:100"


def test_annotate_and_unseen_count():
    ack = {"1:100": 999}
    ann = signalsack.annotate(SIGS, ack)
    assert ann[0]["acked"] is True and ann[1]["acked"] is False
    assert signalsack.unseen_count(SIGS, ack) == 1


def test_merge_adds_keys():
    merged = signalsack.merge({}, ["1:100", "2:200"], at=555)
    assert merged == {"1:100": 555, "2:200": 555}
    # merging again keeps the earliest ack time (idempotent, doesn't reset).
    merged2 = signalsack.merge(merged, ["1:100"], at=777)
    assert merged2["1:100"] == 555


def test_prune_drops_acks_for_signals_no_longer_present():
    ack = {"1:100": 1, "9:999": 1}       # 9:999 is stale — no longer in the live set
    pruned = signalsack.prune(ack, SIGS)
    assert pruned == {"1:100": 1}


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
