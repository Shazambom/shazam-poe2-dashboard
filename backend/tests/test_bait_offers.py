"""Live quotes that beat the EXECUTED market by a wide margin are bait, not arbitrage.

2026-09-17, Forbidden Rites: the live `exalted -> omen-of-light` book came back as
    1 ex per omen (stock 4), 10 ex per omen, 55 ex per omen
while the hourly digest shows the pair actually TRADING at ~2,261 ex per omen (21 omens/hour,
47k exalted of volume). Bulk-exchange price-fixers park absurdly cheap listings they never
honour; sorted cheapest-first they ARE the top of the book, so a loop through them showed
+25,000%. Executed trades are the truth: a live offer paying more than BAIT_FACTOR x the
executed rate is dropped before it becomes an edge. No executed rate -> nothing to judge by,
the book is kept as is.

    python -m pytest backend/tests/test_bait_offers.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import digest, gamedata, orderbook, recipes  # noqa: E402
from app.arbitrage import graph  # noqa: E402

OMEN = [{"rate": 1.0, "stock": 4}, {"rate": 0.1, "stock": 2}, {"rate": 1 / 55, "stock": 2},
        {"rate": 1 / 2250, "stock": 3}, {"rate": 1 / 2300, "stock": 9}]
EXECUTED = 1 / 2261


def test_offers_far_better_than_executed_trades_are_dropped():
    kept = graph.credible_offers(OMEN, EXECUTED)
    assert [round(1 / o["rate"]) for o in kept] == [2250, 2300]      # order preserved, best first


def test_a_genuinely_better_quote_survives():
    """A real edge is a few percent, not a few hundred: +10% on the executed rate stays."""
    offers = [{"rate": EXECUTED * 1.10, "stock": 5}, {"rate": EXECUTED * 0.98, "stock": 5}]
    assert graph.credible_offers(offers, EXECUTED) == offers


def test_no_executed_rate_means_no_judgement():
    assert graph.credible_offers(OMEN, None) == OMEN
    assert graph.credible_offers(OMEN, 0) == OMEN
    assert graph.credible_offers([], EXECUTED) == []


def _build(monkeypatch, books, rates):
    s = {"league": "T", "reference": "exalted", "live_max_age_s": 1800, "allow_digest_edges": True,
         "digest_max_age_h": 6, "allow_recipe_edges": False, "min_edge_depth": 0,
         "min_edge_volume_ref_per_h": 0}
    monkeypatch.setattr(graph, "get_settings", lambda: s)
    monkeypatch.setattr(gamedata, "fees", lambda: {"by_trade": {}})
    monkeypatch.setattr(orderbook, "latest_books", lambda league, max_age: books)
    monkeypatch.setattr(digest, "latest_rates", lambda league, max_age: rates)
    monkeypatch.setattr(digest, "pair_volume", lambda league, window: {})
    monkeypatch.setattr(recipes, "edges", lambda: [])
    return graph.Graph.build()


def _book(offers):
    return {"offers": offers, "rate": offers[0]["rate"], "stock": offers[0]["stock"], "depth": len(offers), "age_s": 10.0}


def _digest(rate):
    return {"rate": rate, "stock": 1000, "volume_from": 1, "volume_to": 1, "hour": 0, "age_s": 60.0}


def test_build_uses_the_credible_part_of_a_live_book(monkeypatch):
    g = _build(monkeypatch, {("exalted", "omen-of-light"): _book(OMEN)},
               {("exalted", "omen-of-light"): _digest(EXECUTED)})
    e = g.edges[("exalted", "omen-of-light")]
    assert e.kind == "live" and round(1 / e.rate) == 2250 and len(e.ladder) == 2
    assert e.meta["bait_dropped"] == 3 and e.meta["depth"] == 2


def test_build_falls_back_to_the_digest_when_the_whole_book_is_bait(monkeypatch):
    g = _build(monkeypatch, {("exalted", "omen-of-light"): _book(OMEN[:3])},
               {("exalted", "omen-of-light"): _digest(EXECUTED)})
    e = g.edges[("exalted", "omen-of-light")]
    assert e.kind == "digest" and round(1 / e.rate) == 2261


def test_build_keeps_a_live_book_with_no_digest_to_compare(monkeypatch):
    g = _build(monkeypatch, {("exalted", "omen-of-light"): _book(OMEN)}, {})
    assert g.edges[("exalted", "omen-of-light")].rate == 1.0
