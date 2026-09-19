"""Ghost Wealth on a real market snapshot — a holding is priced where it trades and cashed out for
the most value through liquid markets.

Owner report (2026-09-19): Preserved Cranium trades in game at 15.5–16 Divine and the Board card
agreed (15.71), yet the Cash-out panel said the one cranium held was worth 7.9 Divine on paper and
would lose ~10 Divine to sell, with a "ghost" of 8 chaos. One cause: the holding's paper value came
from its DIRECT cranium↔exalted market — thin (8 craniums/h) and low (3,652 ex ≈ 7.9 div) — while
the Divine market (1,535/h) and the Chaos market agree at ≈7,270 ex. With paper at half the truth,
the honest sale into Divine read as a +90% "gain", the convert ranker threw it out as a phantom,
and a junk 3-hop path that loses half its value was crowned "best" (the 48.7% slippage).

The rules pinned here:
- ONE value table (Graph.values) prices everything shown: each currency through its deepest
  chain of markets by traded VALUE, a market only as deep as its thinner side.
- Cash-out sells into whichever cash currency nets the most value, never through an illiquid
  market (the route filters' volume / fill-time guards).

Fixture: `tests/fixtures/market_basket_2026-09-19.json` — the Forbidden Rites digest edges among a
basket of valuable non-Divine assets, the hubs, a few junk bridges and two currencies whose only
Divine market is a one-hour fat-finger trade (real executed data).

    python -m pytest backend/tests/test_market_basket.py -q
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import liquidity  # noqa: E402
from app.arbitrage import Edge, Graph  # noqa: E402

FX = json.loads((Path(__file__).parent / "fixtures" / "market_basket_2026-09-19.json").read_text())
REF = FX["reference"]
HUBS = set(FX["hubs"])
GOLD = FX["gold_value_per_1k"]
TOL = 0.03      # the two hub markets of one asset disagree by a few % (VWAP hours, spreads)
# The owner's route filters on the day of the snapshot — the cash-out's illiquidity guard.
FILTERS = {"min_volume_ref_per_h": 100.0, "max_fill_hours": 24}


def _graph() -> Graph:
    s = dict(FX["settings"])
    s.update({"allow_digest_edges": True, "allow_recipe_edges": False, "filters": dict(FILTERS)})
    g = Graph(s)
    g.fee_table = {c: f for c, f in FX["fees_by_trade"].items() if f is not None}
    for e in FX["edges"]:
        g.add(Edge(e["src"], e["dst"], "digest", e["rate"], [{"rate": e["rate"], "stock": e["stock"]}],
                   age_s=e["age_s"], vol_in_per_h=e["vol_in_per_h"]))
    return g


@pytest.fixture(scope="module")
def g():
    return _graph()


@pytest.fixture(scope="module")
def rv(g):
    """THE value table every screen (and cash-out) prices from."""
    return g.values()


def _value_per_h(g, c, h, rv):
    """Executed value of the c↔h market per hour, counted on the HUB side at the hub's worth."""
    e_in, e_out = g.edges.get((h, c)), g.edges.get((c, h))
    hub_units = (e_in.vol_in_per_h if e_in else 0.0) + (e_out.vol_in_per_h * e_out.rate if e_out else 0.0)
    return hub_units * rv[h]


def _deepest_hub(g, c, rv):
    return max((h for h in HUBS if h != c and g.direct_rate(c, h)), key=lambda h: _value_per_h(g, c, h, rv))


# ------------------------------------------------------------------ the snapshot's premise
def test_the_direct_exalted_market_is_the_thin_one(g, rv):
    """Why the old paper value was wrong: for every basket asset the exalted market is not the
    deepest, and ref_values (Arbitrage's valuation: its direct market) sits far below it."""
    for c in FX["basket"]:
        h = _deepest_hub(g, c, rv)
        assert h != REF, c
        implied = g.direct_rate(c, h) * rv[h]
        naive = g.ref_values()[c]
        assert implied / naive > 1.15, f"{c}: ref_values {naive:.0f} ex vs its {h} market {implied:.0f}"


# ------------------------------------------------------------------ priced where it trades
def test_a_holding_is_worth_what_its_deepest_market_says(g, rv):
    for c in FX["basket"]:
        h = _deepest_hub(g, c, rv)
        implied = g.direct_rate(c, h) * rv[h]
        assert abs(rv[c] / implied - 1) < TOL, (c, h)


def test_cranium_matches_the_in_game_price(g, rv):
    """The owner's observation is the ground truth: 15.5 ask / 16 bid Divine."""
    ig = FX["in_game_divine"]["preserved-cranium"]
    in_div = rv["preserved-cranium"] / rv["divine"]
    assert ig["ask"] * (1 - TOL) <= in_div <= ig["bid"] * (1 + TOL), in_div


def test_volume_is_value_not_units(g, rv):
    """Chaos↔Exalted trades far more UNITS per hour than Chaos↔Divine, but a divine is worth ~9
    chaos: depth is value. Chaos is priced through Divine because that market moves more value."""
    ex_units = g.edges[("chaos", REF)].vol_in_per_h + g.edges[(REF, "chaos")].vol_in_per_h / g.direct_rate("chaos", REF)
    div_units = g.edges[("chaos", "divine")].vol_in_per_h + g.edges[("divine", "chaos")].vol_in_per_h * g.direct_rate("divine", "chaos")
    ex_value, div_value = ex_units * rv["chaos"], div_units * rv["chaos"]
    deeper = "divine" if div_value > ex_value else REF
    assert abs(rv["chaos"] / rv[deeper] / g.direct_rate("chaos", deeper) - 1) < 1e-9, (ex_value, div_value)


def test_cash_is_priced_by_the_same_table(g, rv):
    """Cash is priced like everything else (the one table) and realizes at paper."""
    out = liquidity.capital_rows({"divine": 4.0, "chaos": 108.0, REF: 136.0}, g, rv)
    for r in out["rows"]:
        assert r["ref_value"] == rv[r["currency"]] and r["realizable_ref"] == r["value_ref"]


# ------------------------------------------------------------------ cash-out: most value, liquid only
def test_selling_one_cranium_loses_the_rounding_not_half(g, rv):
    """One cranium sells into a cash market for whole units, so the loss is the rounding (the
    owner's "worst case I price it at 15, lose a divine"), not half the value. Gold is a real
    cost on top (126 chaos × 160 gold ≈ 1 div at the owner's gold price) and may change which
    sale nets the most; it is never counted as slippage."""
    free = liquidity.realizable(g, rv, "preserved-cranium", 1, cash=HUBS, gold_value_per_1k=0.0)
    assert free["full_fill"] and free["source"] == "digest"
    assert free["path"][-1] in HUBS
    div = rv["divine"]
    assert free["ghost_ref"] < div, f"ghost {free['ghost_ref'] / div:.2f} div"
    assert 0 <= free["slippage_pct"] < 6, free["slippage_pct"]
    paid = liquidity.realizable(g, rv, "preserved-cranium", 1, cash=HUBS, gold_value_per_1k=GOLD)
    assert 0 <= paid["slippage_pct"] < 6, paid["slippage_pct"]
    assert free["realizable_ref"] > paid["realizable_ref"] > free["realizable_ref"] - 2 * div


def test_cash_out_takes_the_most_value_among_liquid_sales(g, rv):
    """Whatever cash currency the holding is sold into, it is the one that nets the most value —
    not the one with the most units or the biggest market."""
    for c in FX["basket"]:
        r = liquidity.realizable(g, rv, c, 1, cash=HUBS, gold_value_per_1k=0.0)
        # sold INTO cash, only through cash: a detour via a junk bridge (origin-core, breachlord's
        # amalgam — real stale "gains" in this snapshot) is arbitrage, not a cash-out
        assert all(n in HUBS for n in r["path"][1:]), (c, r["path"])
        for h in HUBS:
            if (c, h) not in g.edges:
                continue
            out = int(g.edges[(c, h)].rate)                     # one-hop sale of one unit
            if out < 1 or g.edges[(c, h)].vol_in_per_h * rv[c] < FILTERS["min_volume_ref_per_h"]:
                continue
            worth = rv[h]
            assert r["realizable_ref"] >= min(out * worth, r["paper_ref"]) - 1e-6, (c, h, r["path"])


def test_an_illiquid_market_is_never_the_exit():
    """A fat bid in a market that barely trades is not a real exit: it loses to the liquid sale
    even though it would net more."""
    g = _graph()
    rv = g.values()
    pc = "preserved-cranium"
    g.add(Edge(pc, "mirror", "digest", 1.0, [{"rate": 1.0, "stock": 5}], age_s=0.0, vol_in_per_h=0.001))
    r = liquidity.realizable(g, rv, pc, 1, cash=HUBS, gold_value_per_1k=0.0)
    assert r["path"][-1] != "mirror", r["path"]
    assert r["realizable_ref"] <= r["paper_ref"]


@pytest.mark.parametrize("qty", [1, 5])
def test_the_basket_cashes_out_near_paper(g, rv, qty):
    """Each basket asset has a deep hub market: a small stack realizes within 10% of paper, plus
    at most one whole unit of the cash it is sold into (you receive whole units — 5.6 chaos of
    essence sells for 5). Gold-free: gold is a cost of trading, not of the market."""
    for c in FX["basket"]:
        r = liquidity.realizable(g, rv, c, qty, cash=HUBS, gold_value_per_1k=0.0)
        assert r["realizable_ref"] is not None, c
        unit = rv[r["path"][-1]]
        assert r["ghost_ref"] < 0.10 * r["paper_ref"] + unit, f"{c} ×{qty}: ghost {r['ghost_ref'] / r['paper_ref']:.1%} via {r['path']}"
        assert r["full_fill"], c


def test_capital_totals_follow(g, rv, monkeypatch):
    """The /api/capital shape — the owner's actual holdings on this snapshot."""
    from app import settings as settings_mod
    monkeypatch.setattr(settings_mod, "gold_value_per_1k", lambda s: 0.0)
    monkeypatch.setattr(liquidity, "cash_set", lambda g_, rv_: HUBS)
    caps = {"preserved-cranium": 1.0, "fracturing-orb": 11.0, "essence-of-delirium": 12.0,
            "divine": 4.0, "chaos": 108.0, "exalted": 136.0}
    out = liquidity.capital_rows(caps, g, rv)
    assert out["ghost_ref"] / out["total_ref"] < 0.06, out["ghost_ref"] / out["total_ref"]
    row = {r["currency"]: r for r in out["rows"]}
    assert abs(row["preserved-cranium"]["ref_value"] / rv["divine"] - 15.71) < 0.1
    assert row["fracturing-orb"]["slippage_pct"] < 6 and row["fracturing-orb"]["full_fill"]


# ------------------------------------------------------------------ ONE value table (Graph.values)
# Every screen that shows a price reads Graph.values(): the Board, the zoomed card, Capital and
# its cash-out, the top bar's wealth, Hold, Movers, Convert AND the Arbitrage route search.
# ref_values() survives only inside values(), to size the far side of a market and to price what
# has no market at all.
def test_values_price_each_asset_through_its_deepest_market(g):
    V = g.values()
    for c in FX["basket"]:
        h = _deepest_hub(g, c, V)
        assert abs(V[c] / V[h] / g.direct_rate(c, h) - 1) < TOL, (c, h, V[c] / V[h], g.direct_rate(c, h))


def test_values_match_the_in_game_cranium(g):
    V = g.values()
    ig = FX["in_game_divine"]["preserved-cranium"]
    assert ig["ask"] * (1 - TOL) <= V["preserved-cranium"] / V["divine"] <= ig["bid"] * (1 + TOL)


def test_values_ignore_a_one_sided_fat_finger(g):
    """2,900 Divine traded into 53 Lesser Essences of Battle in one hour: deep in Divine, nothing in
    essences. A market is only as deep as its thinner side, so the essence keeps its own price."""
    V = g.values()
    for c in FX["garbage"]:
        own = g.direct_rate(c, REF) or 1 / g.edges[(REF, c)].rate
        assert V[c] < 3 * own, (c, V[c], own)


def test_hubs_keep_their_deep_markets(g):
    V = g.values()
    assert V[REF] == 1.0
    assert abs(V["divine"] / g.direct_rate("divine", REF) - 1) < TOL


def test_values_are_one_consistent_table(g):
    """No two prices of one thing: the cranium's price in Divine, times what the Mirror card says
    a Mirror is worth in Divine, is the cranium in Mirrors — the contradiction the owner saw (one
    card reading 16.77 div and 4,620 ex at once) cannot be expressed in one table."""
    V = g.values()
    for c in FX["basket"]:
        for a, b in (("divine", "chaos"), ("divine", "mirror"), ("chaos", REF)):
            in_a, a_in_b = V[c] / V[a], V[a] / V[b]
            assert abs(in_a * a_in_b - V[c] / V[b]) < 1e-9 * (V[c] / V[b]), (c, a, b)


# ------------------------------------------------------------------ what the review found
def test_a_fat_finger_in_the_only_market_is_not_a_price(g):
    """The side test needs evidence the suspect market cannot fabricate. A currency whose ONLY
    market is the fat-finger one had its floor derived from that very trade, so both sides agreed
    and it priced at 54 Divine an essence."""
    import types
    from app import leaguehistory
    fx = _graph()
    fx.add(Edge("divine", "bogus-shard", "digest", 1 / 54.0, [{"rate": 1 / 54.0, "stock": 60}],
                age_s=0.0, vol_in_per_h=2_900))                 # 2,900 divine/h, no other market
    V = fx.values()
    assert V["bogus-shard"] / V["divine"] > 50                  # with no outside evidence, it stands
    # poe2scout says it is worth ~1 exalted: that is independent, and the market is rejected.
    fx2 = _graph()
    fx2.add(Edge("divine", "bogus-shard", "digest", 1 / 54.0, [{"rate": 1 / 54.0, "stock": 60}],
                 age_s=0.0, vol_in_per_h=2_900))
    fx2._scout_values = types.MethodType(lambda self: {"bogus-shard": 1.0}, fx2)
    V2 = fx2.values()
    assert abs(V2["bogus-shard"] - 1.0) < 1e-9, V2["bogus-shard"]


def test_a_vendor_recipe_rate_never_prices_a_currency(g):
    """Recipes are a fixed vendor rate nobody trades at. One in the direction the rate lookup
    reads first priced a shard at half what its market said."""
    fx = _graph()
    fx.add(Edge(REF, "shardy", "digest", 10.0, [{"rate": 10.0, "stock": 9_000}], age_s=0.0, vol_in_per_h=5_000))
    fx.add(Edge("shardy", REF, "recipe", 0.05, [], age_s=0.0, vol_in_per_h=0.0))
    assert abs(fx.values()["shardy"] - 0.1) < 1e-9              # its market, not the vendor's 0.05


def test_the_parent_map_never_outlives_its_table(g):
    """`priced_by` says which market priced each currency; a card reads it to decide whose history
    to draw. It must not survive the table it was built with."""
    fx = _graph()
    fx.values()
    assert fx.priced_by
    fx.add(Edge("divine", "whatever", "digest", 1.0, [{"rate": 1.0, "stock": 1}], age_s=0.0, vol_in_per_h=1.0))
    assert fx.priced_by == {} and fx._values is None
