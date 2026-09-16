"""TDD for Phase 6 — the sidecar analytics TRANSPORT (SQLite, no network).

`app.analytics` is the one shared, stdlib-only, connection-INJECTED transport used by both
sides of the supervision tree:
  - the backend enqueues jobs + reads the results cache (via db's ATTACHed `market` conn),
  - the lean sidecar claims jobs, runs the compute, writes the cache (via its own market conn).

Because it is connection-injected and imports no app.db, the sidecar can import it without
triggering the backend's DB boot. Two tables (market side, self-healed on boot):
  analytics_jobs  — control channel: backend enqueues 'queued'; sidecar claims → running → done/error.
  analytics_cache — results: sidecar is SOLE writer; backend/endpoints only READ (graceful degrade).

Run:  DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_analytics.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import analytics, db  # noqa: E402


def _conn():
    return db._conn()


def _clear():
    c = _conn()
    c.execute("DELETE FROM analytics_jobs")
    c.execute("DELETE FROM analytics_cache")
    c.commit()


def test_enqueue_then_claim_is_exactly_once():
    _clear()
    c = _conn()
    jid = analytics.enqueue(c, "discords", {"league": "Std"})
    assert isinstance(jid, int) and jid > 0

    first = analytics.claim(c)
    assert first is not None
    assert first["id"] == jid and first["kind"] == "discords"
    assert first["params"] == {"league": "Std"}      # params_json round-trips to a dict

    # A second claim finds nothing queued — the job is exactly-once.
    assert analytics.claim(c) is None


def test_enqueue_coalesces_duplicate_queued_jobs():
    _clear()
    c = _conn()
    a = analytics.enqueue(c, "discords")
    b = analytics.enqueue(c, "discords")          # same kind still queued -> no new row
    assert a == b
    n = c.execute("SELECT COUNT(*) FROM analytics_jobs WHERE kind='discords'").fetchone()[0]
    assert n == 1
    # coalesce=False forces a distinct row.
    d = analytics.enqueue(c, "discords", coalesce=False)
    assert d != a


def test_complete_writes_cache_and_marks_done():
    _clear()
    c = _conn()
    jid = analytics.enqueue(c, "discords")
    job = analytics.claim(c)
    analytics.complete(c, job["id"], "discords", "62", {"z": 3.1, "day": "2026-09-14"})

    assert analytics.read_cache(c, "discords", "62") == {"z": 3.1, "day": "2026-09-14"}
    st = c.execute("SELECT state, finished_at FROM analytics_jobs WHERE id=?", (jid,)).fetchone()
    assert st[0] == "done" and st[1] is not None


def test_complete_upserts_same_key():
    _clear()
    c = _conn()
    analytics.complete(c, None, "discords", "62", {"z": 1.0})
    analytics.complete(c, None, "discords", "62", {"z": 9.0})     # overwrite, not duplicate
    assert analytics.read_cache(c, "discords", "62") == {"z": 9.0}
    n = c.execute("SELECT COUNT(*) FROM analytics_cache WHERE kind='discords'").fetchone()[0]
    assert n == 1


def test_fail_marks_error():
    _clear()
    c = _conn()
    jid = analytics.enqueue(c, "discords")
    job = analytics.claim(c)
    analytics.fail(c, job["id"], "boom")
    row = c.execute("SELECT state, error FROM analytics_jobs WHERE id=?", (jid,)).fetchone()
    assert row[0] == "error" and row[1] == "boom"


def test_read_cache_list_mode():
    _clear()
    c = _conn()
    analytics.complete(c, None, "discords", "10", {"z": 2.0})
    analytics.complete(c, None, "discords", "20", {"z": 4.0})
    rows = analytics.read_cache(c, "discords")           # no key -> list of {key, computed_at, value}
    assert {r["key"] for r in rows} == {"10", "20"}
    assert all("value" in r and "computed_at" in r for r in rows)
    # missing key -> None (never raises; endpoints depend on this)
    assert analytics.read_cache(c, "discords", "nope") is None
    assert analytics.read_cache(c, "no-such-kind") == []


def test_claim_is_fifo_across_kinds():
    """The single consumer claims the OLDEST queued job of any kind (it dispatches by kind itself),
    so mixed kinds come out in enqueue order."""
    _clear()
    c = _conn()
    analytics.enqueue(c, "discords")
    analytics.enqueue(c, "arc")
    first = analytics.claim(c)
    second = analytics.claim(c)
    assert [first["kind"], second["kind"]] == ["discords", "arc"]
    assert analytics.claim(c) is None


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
