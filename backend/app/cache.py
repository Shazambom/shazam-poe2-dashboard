"""The one TTL memo used by every module-level cache in the backend.

Each module keeps its own `store: dict` (so invalidation stays local and explicit) and its own
TTL; only the bookkeeping — timestamp, optional version stamp, expiry check — lives here.

    _cache: dict = {}
    def thing(league):
        return cache.memo(_cache, league, 300, lambda: build(league))

`version` (e.g. orderbook.state["version"]) invalidates the entry when it changes, regardless
of age. Stdlib-only.
"""
from __future__ import annotations

import time
from typing import Any, Callable, Hashable


_MISS = object()


def get(store: dict, key: Hashable, ttl_s: float, version: Any = None) -> Any:
    """The cached value if it is younger than ttl_s and stamped with `version`, else cache.MISS."""
    hit = store.get(key)
    if hit and time.time() - hit[0] < ttl_s and hit[1] == version:
        return hit[2]
    return _MISS


def put(store: dict, key: Hashable, value: Any, version: Any = None, max_entries: int | None = None) -> Any:
    store[key] = (time.time(), version, value)
    if max_entries and len(store) > max_entries:
        oldest = min(store, key=lambda k: store[k][0])
        store.pop(oldest, None)
    return value


def memo(store: dict, key: Hashable, ttl_s: float, build: Callable[[], Any], version: Any = None) -> Any:
    value = get(store, key, ttl_s, version)
    if value is _MISS:
        value = put(store, key, build(), version)
    return value


MISS = _MISS


def clear(store: dict) -> None:
    store.clear()
