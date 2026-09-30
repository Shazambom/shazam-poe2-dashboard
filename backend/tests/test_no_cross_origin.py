"""No other website may talk to the local backend.

Audit 2026-09-29 (docs/bugs/2026-09-29-audit-open-items.md, D2): the backend allowed every origin
(`CORSMiddleware(allow_origins=["*"])`) on a fixed loopback port. Dropping CORS stops cross-origin
reads and preflighted writes, but a page can still fire a simple POST with `mode: 'no-cors'` (e.g.
`/api/oauth/logout`), and a DNS-rebinding page can read every GET. So the desktop backend
(`run_desktop.py` sets ARBITER_LOOPBACK_ONLY=1) also refuses any request whose Host is not loopback
or whose Origin is another site. The app window's Origin is the loopback UI server; Electron's main
process sends none. The web env (nginx in front, Host `backend:8000`) does not set the flag.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_no_cross_origin.py -q
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from fastapi.testclient import TestClient  # noqa: E402
from app import main  # noqa: E402

LOOP = {"Host": "127.0.0.1:8210"}


@pytest.fixture
def desktop(monkeypatch):
    monkeypatch.setenv("ARBITER_LOOPBACK_ONLY", "1")
    return TestClient(main.app)


def test_a_foreign_origin_gets_no_cors_permission():
    r = TestClient(main.app).options("/api/settings", headers={
        "Origin": "https://evil.example", "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type"})
    assert "access-control-allow-origin" not in r.headers


def test_a_no_cors_post_from_another_site_is_refused(desktop):
    r = desktop.post("/api/oauth/logout", headers={**LOOP, "Origin": "https://evil.example"})
    assert r.status_code == 403


def test_a_dns_rebinding_host_is_refused(desktop):
    assert desktop.get("/api/status", headers={"Host": "evil.example:8210"}).status_code == 403


def test_the_app_window_and_electron_main_are_allowed(desktop):
    assert desktop.get("/api/status", headers={**LOOP, "Origin": "http://127.0.0.1:53117"}).status_code == 200
    assert desktop.get("/api/status", headers={"Host": "localhost:8210"}).status_code == 200


def test_the_web_env_is_unaffected(monkeypatch):
    monkeypatch.delenv("ARBITER_LOOPBACK_ONLY", raising=False)
    r = TestClient(main.app).get("/api/status", headers={"Host": "backend:8000", "Origin": "https://shazam.lan"})
    assert r.status_code == 200


def test_the_desktop_entrypoint_turns_it_on():
    assert 'ARBITER_LOOPBACK_ONLY' in (Path(__file__).resolve().parents[1] / "run_desktop.py").read_text()
