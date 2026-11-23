"""HTTP client tests with local data and a fake transport."""

import io
import runpy
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import devtelemetry

CONNECT = Path(__file__).resolve().parents[2] / "tools" / "connect.py"


def test_connect_refuses_a_file_url(tmp_path):
    connect = runpy.run_path(str(CONNECT))
    (tmp_path / "report.json").write_text('{"local": true}')
    with pytest.raises(ValueError, match="HTTP or HTTPS"):
        connect["call"](tmp_path.as_uri(), "/report.json")


def test_connect_passes_method_url_and_body_to_http_transport(monkeypatch):
    connect = runpy.run_path(str(CONNECT))
    seen = []

    def open_request(_opener, request, data=None, timeout=None):
        seen.append((request.full_url, request.get_method(), request.data, timeout))
        return io.BytesIO(b'{"ok": true}')

    monkeypatch.setattr(urllib.request.OpenerDirector, "open", open_request)
    response = connect["call"](
        "https://dashboard.invalid", "/api/call", "POST", {"x": 1}
    )
    assert response == {"ok": True}
    assert seen == [("https://dashboard.invalid/api/call", "POST", b'{"x": 1}', 60)]


def test_telemetry_uses_the_existing_http_url_and_payload(monkeypatch):
    seen = []

    def open_request(_opener, request, data=None, timeout=None):
        seen.append((request.full_url, request.get_method(), request.data, timeout))
        return io.BytesIO()

    monkeypatch.setattr(urllib.request.OpenerDirector, "open", open_request)
    devtelemetry._post(b"test report")
    assert seen == [(devtelemetry._URL, "POST", b"test report", 4)]


@pytest.mark.parametrize("client", ["connect", "telemetry"])
def test_http_openers_disable_ftp_even_when_a_proxy_is_configured(monkeypatch, client):
    def unexpected_transport(*_args):
        pytest.fail("FTP reached a network handler")

    monkeypatch.setattr(urllib.request.HTTPHandler, "http_open", unexpected_transport)
    monkeypatch.setattr(urllib.request.FTPHandler, "ftp_open", unexpected_transport)
    monkeypatch.setattr(
        urllib.request,
        "getproxies",
        lambda: {"ftp": "http://proxy.invalid:8080"},
    )
    if client == "connect":
        make_opener = runpy.run_path(str(CONNECT))["_http_opener"]
    else:
        make_opener = devtelemetry._http_opener
    make_opener.cache_clear()
    try:
        with pytest.raises(urllib.error.URLError, match="unknown url type: ftp"):
            make_opener().open("ftp://dashboard.invalid/report")
    finally:
        make_opener.cache_clear()
