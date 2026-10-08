"""A new digest hour invalidates every memo that reads the digest (owner's packaged check, 2026-10-08: after a day
closed, the app caught its market data up within two minutes but showed no loops for ten, because `pair_volume` —
the depth yardstick every market edge must pass — kept the empty answer it had computed while the data was stale.
`window_rates` already rebuilds on `state["last_hour"]`; the volume memos follow the same rule)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import digest  # noqa: E402


def _counting(monkeypatch, name, value):
    calls = []
    monkeypatch.setattr(digest, name, lambda *a, **k: (calls.append(1), value)[1])
    return calls


def test_pair_volume_and_partners_rebuild_when_a_digest_hour_lands(monkeypatch):
    vol = _counting(monkeypatch, "_pair_volume", {("a", "b"): 1.0})
    par = _counting(monkeypatch, "_partners", [("a", 1.0)])
    digest._volume_cache.clear(); digest._partners_cache.clear()
    monkeypatch.setitem(digest.state, "last_hour", 1_000)
    digest.pair_volume("L", 24); digest.pair_volume("L", 24)
    digest.partners("L", "b", 168); digest.partners("L", "b", 168)
    assert (len(vol), len(par)) == (1, 1), "memoized within the hour"
    monkeypatch.setitem(digest.state, "last_hour", 1_000 + 3600)   # the catch-up landed
    assert digest.pair_volume("L", 24) == {("a", "b"): 1.0}
    assert digest.partners("L", "b", 168) == [("a", 1.0)]
    assert (len(vol), len(par)) == (2, 2), "a new digest hour rebuilds both, whatever the TTL"
