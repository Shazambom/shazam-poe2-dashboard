"""A route search the page abandons stops (docs/learnability-plan.md part 5). Every Arbitrage edit starts a new
search and closes the previous stream; the backend used to keep working on the closed one to the end."""
import asyncio
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app.arbitrage import routes  # noqa: E402


def _fake_search(monkeypatch, produced):
    """A search with endless candidates; counts how many it was asked for."""
    s = {"reference": "exalted", "routes_cache_s": 300, "rank_weights": {}}
    monkeypatch.setattr(routes, "_search_setup", lambda f, st: (object(), s, {"limit": 100}, {}, {}, ["chaos"], True))
    monkeypatch.setattr(routes, "_cache_get", lambda key, s: None)
    monkeypatch.setattr(routes, "_graph_summary", lambda g: {})
    puts = []
    monkeypatch.setattr(routes, "_cache_put", lambda key, result: puts.append(key))

    def endless(*a, **k):
        i = 0
        while True:
            i += 1
            produced.append(i)
            yield {"id": f"r{i}", "margin_pct": 1}
    monkeypatch.setattr(routes, "_iter_candidates", endless)
    monkeypatch.setattr(routes, "_keep", lambda r, f: True)
    return puts


def test_a_cancelled_search_stops_within_a_few_candidates_and_caches_nothing(monkeypatch):
    produced = []
    puts = _fake_search(monkeypatch, produced)
    stop = threading.Event()
    kinds = []
    for kind, _ in routes.stream_routes({}, None, cancelled=stop.is_set):
        kinds.append(kind)
        if len(kinds) == 10:
            stop.set()                      # the page closed the stream
    assert kinds[0] == "meta" and "done" not in kinds
    assert len(produced) < 10 + routes.CANCEL_CHECK_EVERY + 1, "stops at the next check, not at the end"
    assert puts == [], "a cut-short result is never cached as if it were complete"


def test_an_uncancelled_search_still_finishes(monkeypatch):
    produced = []
    _fake_search(monkeypatch, produced)
    finite = lambda *a, **k: iter([{"id": "a", "margin_pct": 1, "score": 1}, {"id": "b", "margin_pct": 1, "score": 0.5}])
    monkeypatch.setattr(routes, "_iter_candidates", finite)
    monkeypatch.setattr(routes, "_finish", lambda rs, f, s: (rs, 100))
    monkeypatch.setattr(routes, "_result", lambda *a, **k: {})
    monkeypatch.setattr(routes, "_diag", lambda *a, **k: None)
    kinds = [k for k, _ in routes.stream_routes({}, None, cancelled=lambda: False)]
    assert kinds == ["meta", "route", "route", "done"]


def test_the_endpoint_stops_the_search_when_the_page_disconnects(monkeypatch):
    from app import main
    seen = {}

    def fake_stream(f, starts, cancelled):
        seen["cancelled"] = cancelled
        i = 0
        while not cancelled():
            i += 1
            yield "route", {"id": f"r{i}"}
        seen["stopped_after"] = i
    monkeypatch.setattr(main.arbitrage, "stream_routes", fake_stream)

    class Gone:
        """A request whose client has gone after the first chunk."""
        n = 0
        async def is_disconnected(self):
            self.n += 1
            return self.n > 1

    resp = main.routes_stream(Gone(), main.RouteQuery())

    async def drain():
        return [chunk async for chunk in resp.body_iterator]
    chunks = asyncio.run(drain())
    assert len(chunks) <= 2
    assert seen["cancelled"]() is True, "the search was told to stop"


def test_a_long_quiet_search_tells_the_page_it_is_still_working(monkeypatch):
    """Code review 2026-10-05: with strict filters nothing passes for a while, the stream went silent, and the page's
    30 s idle watchdog cancelled and restarted it from zero, forever. A quiet search now emits `progress`."""
    produced = []
    _fake_search(monkeypatch, produced)
    monkeypatch.setattr(routes, "_keep", lambda r, f: False)            # strict: nothing passes
    clock = iter(range(0, 10_000, 1))                                    # every call is a second later
    monkeypatch.setattr(routes.time, "time", lambda: float(next(clock)))
    kinds = []
    for kind, _ in routes.stream_routes({}, None, cancelled=lambda: len(produced) > 2000):
        kinds.append(kind)
    assert "progress" in kinds and "route" not in kinds


def test_a_cancelled_search_never_starts_the_deep_scan(monkeypatch):
    called = []
    monkeypatch.setattr(routes.deepscan, "deep_loops", lambda g, rv: called.append(1) or [])
    monkeypatch.setattr(routes, "search_cycles", lambda *a, **k: iter([]))
    list(routes._iter_candidates(object(), {"max_steps": 3, "max_start_fraction": 1}, {}, {}, ["chaos"], True,
                                 cancelled=lambda: True))
    assert called == []
