"""A native price is the market's own TRADED rate, never the worst-case side of a dead market.

Audit 2026-09-29 (docs/bugs/2026-09-29-audit-open-items.md, A1): Orb of Transmutation's exalted
market is a secondary, dead (wide-spread) market, so its edge keeps the extreme rate the route
search needs (you sell at the cheapest hour: 0.0319 ex). `native_price` showed that as the price on
Capital and the Mods page, while the market traded at 0.577 ex (`quoted_rate`). The volume rule
(CLAUDE.md) prices a thing at "that market's own rate": what it traded at.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_native_price_dead_market.py -q
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import arbitrage  # noqa: E402
from app.arbitrage import Edge, Graph  # noqa: E402
from app.settings import DEFAULTS  # noqa: E402


def _edge(src, dst, rate, *, inactive=False, quoted=None, vol=100.0):
    e = Edge(src, dst, "digest", rate, [{"rate": rate, "stock": 1000}], vol_in_per_h=vol)
    e.meta.update({"inactive": inactive, "quoted_rate": quoted if quoted is not None else rate})
    return e


def _graph(*edges):
    g = Graph(dict(DEFAULTS, reference="exalted"))
    for e in edges:
        g.add(e)
    return g


def test_a_dead_market_shows_what_it_traded_at_not_its_worst_hour():
    g = _graph(_edge("transmute", "exalted", 0.0319, inactive=True, quoted=0.577))
    rv = {"exalted": 1.0, "transmute": 1.36}
    ranked = {"transmute": [(1.0, "exalted")]}
    rate, cur = arbitrage.native_price(g, "transmute", rv, ranked, "exalted")
    assert cur == "exalted"
    assert rate == pytest.approx(0.577)


def test_a_dead_market_seen_from_its_other_side_inverts_the_traded_rate():
    # Only buyers-side edge exists: exalted -> essence at the dearest hour (1/39.9), traded 1/25.
    g = _graph(_edge("exalted", "essence", 1 / 39.9, inactive=True, quoted=1 / 25.0))
    rv = {"exalted": 1.0, "essence": 30.0}
    ranked = {"essence": [(1.0, "exalted")]}
    rate, cur = arbitrage.native_price(g, "essence", rv, ranked, "exalted")
    assert (rate, cur) == (pytest.approx(25.0), "exalted")


def test_a_live_market_keeps_its_rate_and_the_route_edge_is_untouched():
    dead = _edge("transmute", "exalted", 0.0319, inactive=True, quoted=0.577)
    g = _graph(dead, _edge("omen", "exalted", 0.955))
    rv = {"exalted": 1.0, "transmute": 1.36, "omen": 6.0}
    ranked = {"omen": [(1.0, "exalted")], "transmute": [(1.0, "exalted")]}
    assert arbitrage.native_price(g, "omen", rv, ranked, "exalted") == (pytest.approx(0.955), "exalted")
    arbitrage.native_price(g, "transmute", rv, ranked, "exalted")
    assert dead.rate == 0.0319 and g.direct_rate("transmute", "exalted") == 0.0319, "routes still see the worst case"


def test_a_recipe_that_displaced_a_dead_market_is_not_its_traded_price():
    """A recipe beats a dead market's worst-case edge and takes its slot (routes want the better
    conversion), but the market's traded rate still prices the thing (code review 2026-09-29)."""
    dead = _edge("shard", "orb", 0.01, inactive=True, quoted=0.05)
    g = _graph(dead)
    g.add_recipe({"from": "shard", "to": "orb", "rate": 0.1, "lot": 10, "recipe_id": "r1", "name": "10 shards", "kind": "vendor"})
    assert g.edges[("shard", "orb")].kind == "recipe", "routes see the recipe"
    assert g.traded_rate("shard", "orb") == pytest.approx(0.05)


def test_a_recipe_the_market_already_beats_is_not_added():
    g = _graph(_edge("shard", "orb", 0.2))
    g.add_recipe({"from": "shard", "to": "orb", "rate": 0.1, "lot": 10, "recipe_id": "r1", "name": "x", "kind": "vendor"})
    assert g.edges[("shard", "orb")].kind == "digest"


def test_a_recipe_alone_is_no_market_price():
    g = _graph()
    g.add_recipe({"from": "shard", "to": "orb", "rate": 0.1, "lot": 10, "recipe_id": "r1", "name": "x", "kind": "vendor"})
    assert g.traded_rate("shard", "orb") is None
