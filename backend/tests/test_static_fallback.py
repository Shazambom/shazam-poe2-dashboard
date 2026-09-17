"""Names + icons come only from GGG's /data/static. One failed fetch at boot must not leave the app
text-only: the last good copy is cached in kv and applied, and a background retry recovers."""
import asyncio

import pytest

from app import currencies, db, gateway

STATIC = {"result": [{"id": "Currency", "label": "Currency", "entries": [
    {"id": "divine", "text": "Divine Orb", "image": "/gen/image/divine.png"},
    {"id": "zz-new", "text": "Brand New Orb", "image": "/gen/image/new.png"}]}]}


class _Resp:
    def __init__(self, data): self._d = data
    def raise_for_status(self): pass
    def json(self): return self._d


@pytest.fixture
def reg(monkeypatch):
    db.kv_set(currencies.STATIC_CACHE_KEY, None)
    return currencies.Registry() if hasattr(currencies, "Registry") else type(currencies.registry)()


def _serve(monkeypatch, result):
    async def request(*a, **k):
        if isinstance(result, Exception):
            raise result
        return _Resp(result)
    monkeypatch.setattr(gateway, "request", request)


def test_live_fetch_sets_icons_and_caches(reg, monkeypatch):
    _serve(monkeypatch, STATIC)
    assert asyncio.run(reg.load_static()) is True
    assert reg.by_id["zz-new"].icon == "/gen/image/new.png"
    assert db.kv_get(currencies.STATIC_CACHE_KEY)["result"][0]["entries"][1]["image"] == "/gen/image/new.png"


def test_failed_fetch_applies_the_cached_copy(reg, monkeypatch):
    _serve(monkeypatch, STATIC)
    asyncio.run(reg.load_static())
    fresh = type(reg)()                                   # next boot
    _serve(monkeypatch, RuntimeError("429"))
    assert asyncio.run(fresh.load_static()) is False
    assert fresh.by_id["zz-new"].icon == "/gen/image/new.png"
    assert not fresh.loaded_at                            # still owes a live fetch → retry loop runs


def test_failed_fetch_without_cache_degrades_quietly(reg, monkeypatch):
    _serve(monkeypatch, RuntimeError("offline"))
    assert asyncio.run(reg.load_static()) is False
    assert "zz-new" not in reg.by_id


def test_empty_payload_is_a_failure_not_a_wipe(reg, monkeypatch):
    _serve(monkeypatch, STATIC)
    asyncio.run(reg.load_static())
    _serve(monkeypatch, {"result": []})
    assert asyncio.run(reg.load_static()) is False
    assert db.kv_get(currencies.STATIC_CACHE_KEY)["result"]


def test_retry_loop_recovers(reg, monkeypatch):
    calls = {"n": 0}
    async def request(*a, **k):
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("flaky")
        return _Resp(STATIC)
    monkeypatch.setattr(gateway, "request", request)
    async def nosleep(_): pass
    monkeypatch.setattr(currencies.asyncio, "sleep", nosleep)
    asyncio.run(reg.keep_static_fresh())
    assert reg.loaded_at and reg.by_id["divine"].icon
