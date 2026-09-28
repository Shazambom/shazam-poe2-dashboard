"""One dev-telemetry sender for both Python processes (backend supervisor + sidecar), gated on
ARBITER_TELEMETRY (set by Electron only on the beta/dev channel).

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_devtelemetry.py -q
"""
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import devtelemetry, sidecar_supervisor  # noqa: E402
from sidecar import runner  # noqa: E402


def _capture(monkeypatch):
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append((req.full_url, req.data.decode(), dict(req.headers)))

        class R:
            def close(self):
                pass
        return R()
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return calls


def test_silent_without_the_gate(monkeypatch):
    calls = _capture(monkeypatch)
    monkeypatch.delenv("ARBITER_TELEMETRY", raising=False)
    devtelemetry.tlog("sidecar", "hello")
    assert calls == []


def test_posts_marker_version_and_tag_when_gated_on(monkeypatch):
    calls = _capture(monkeypatch)
    monkeypatch.setenv("ARBITER_TELEMETRY", "1")
    monkeypatch.setenv("ARBITER_VERSION", "9.9.9")
    devtelemetry.tlog("supervisor", "spawned")
    assert devtelemetry.flush(5)
    assert len(calls) == 1
    url, body, headers = calls[0]
    assert url == "http://192.168.1.250:8080/api/installlog?p=sidecar"
    assert body.startswith("v9.9.9 ") and "[supervisor]" in body and body.endswith("spawned")
    assert headers.get("Content-type") == "text/plain"


def test_never_raises(monkeypatch):
    monkeypatch.setenv("ARBITER_TELEMETRY", "1")

    def boom(*a, **k):
        raise OSError("down")
    monkeypatch.setattr(urllib.request, "urlopen", boom)
    devtelemetry.tlog("sidecar", "x")
    assert devtelemetry.flush(5), "a failed post is dropped; the worker lives on"
    devtelemetry.tlog("sidecar", "y")
    assert devtelemetry.flush(5)


def test_both_processes_use_the_shared_sender():
    src_sup = Path(sidecar_supervisor.__file__).read_text()
    src_run = Path(runner.__file__).read_text()
    for src in (src_sup, src_run):
        assert "192.168.1.250" not in src
        assert "urllib" not in src
    assert "devtelemetry" in src_sup and "devtelemetry" in src_run


def test_a_slow_or_unreachable_server_never_blocks_the_caller(monkeypatch):
    """tlog is called straight from the backend's event loop (the crawl, the seed, the mods check).
    A beta client off the owner's LAN waits out urlopen's timeout on every line, so the caller must
    only queue the line: one worker posts, in order, and flush() drains it (at exit too)."""
    import threading
    import time
    monkeypatch.setenv("ARBITER_TELEMETRY", "1")
    gate, sent = threading.Event(), []

    def slow(req, timeout=None):
        gate.wait(5)
        sent.append(req.data.decode().rsplit("]: ", 1)[1])

        class R:
            def close(self):
                pass
        return R()
    monkeypatch.setattr(urllib.request, "urlopen", slow)
    t = time.monotonic()
    for i in range(3):
        devtelemetry.tlog("lh", f"line {i}")
    assert time.monotonic() - t < 0.2, "tlog waited on the network"
    assert sent == []
    gate.set()
    assert devtelemetry.flush(5)
    assert sent == ["line 0", "line 1", "line 2"], "one worker keeps the order"
