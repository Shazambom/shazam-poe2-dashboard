"""The live price board: each watched currency priced in the reference with spread, depth,
freshness, trend and %-change over the app-wide window; plus the edge table / pair list."""
from __future__ import annotations

from .. import cache, centrality, digest, leaguehistory, marketseries, orderbook, session
from .. import settings as settings_mod
from ..currencies import registry
from ..settings import get_settings
from . import graph
from .graph import INF

_board_cache: dict = {}
BOARD_TTL_S = 30.0


def counterparts_by_volume(g, rv: dict[str, float]) -> dict[str, list[tuple[float, str]]]:
    """Per-currency counterpart markets, ranked by traded value/hour (units × ref value) — a
    fair, direction-symmetric measure of each market's size. THE volume rule: the board's default
    numeraire and the league arc's fallback numeraire both walk this ranking."""
    ranked: dict[str, list[tuple[float, str]]] = {}
    for (a, b), e in g.edges.items():
        if e.kind == "recipe" or not e.vol_in_per_h:
            continue
        volr = e.vol_in_per_h * (rv.get(a) or 0.0)
        for node, other in ((a, b), (b, a)):
            ranked.setdefault(node, []).append((volr, other))
    for lst in ranked.values():
        lst.sort(reverse=True)
    return ranked


def board(window_h: int = 24) -> dict:
    """Live price board: each watched currency priced in the reference, with the
    buy/sell rates that make up the spread, depth, freshness, and a trend series.

    `window_h` is the trend/%-change horizon (24h, 3d, 7d, 14d from the UI): the sparkline
    spans it and change_pct is measured over it.

    Prices are R-per-unit (reference currency per 1 of the currency), so bigger = more
    valuable — the natural way to read a price. buy = what it costs you to acquire one
    (from the R->c ladder), sell = what you get for one (from the c->R ladder).

    Result is TTL-cached: it runs one history query per watched currency, but the
    underlying digest only changes hourly, so repeated polls are served from memory
    (invalidated when a new live book lands, via orderbook.state["version"])."""
    s0 = get_settings()
    window_h = max(1, int(window_h or 24))
    key = (s0["league"], s0["reference"], tuple(s0["watchlist"]), window_h, s0.get("hub_count"))
    return cache.memo(_board_cache, key, BOARD_TTL_S, lambda: _board(window_h),
                      version=orderbook.state["version"])


def _board(window_h: int) -> dict:
    g = graph.cached_graph()
    s = g.s
    R = s["reference"]
    league = s["league"]
    rv = g.ref_values()
    ranked = counterparts_by_volume(g, rv)   # default numeraire: the highest-volume readable counterpart
    hub_ids = centrality.hubs(g, rv, settings_mod.hub_count(s))   # top PageRank → Board "hub" chip (count user-tunable)
    # One-time: seed the board with the market's hub currencies so a fresh board always shows the
    # central markets. Runs once, only once real hubs are known (skips the cold graph), then the
    # user owns the board — later removals stick (mirrors the _liq_floor_v1 seed in settings.py).
    if hub_ids and not s.get("_hub_seed_v1"):
        missing = centrality.seed_missing(s["watchlist"], hub_ids, R)
        settings_mod.save_settings({"watchlist": s["watchlist"] + missing, "_hub_seed_v1": True})
        s["watchlist"] = s["watchlist"] + missing
    scout = leaguehistory.scout_prices(league)   # poe2scout fallback prices (Exalted), by name/slug
    scout_hist = leaguehistory.scout_history(league)   # poe2scout daily trend, by name/slug
    rows = []
    for c in [x for x in s["watchlist"] if x != R]:
        buy_edge = g.edges.get((R, c))     # c per R  -> price to BUY c = 1/rate
        sell_edge = g.edges.get((c, R))    # R per c  -> price to SELL c = rate
        buy = (1.0 / buy_edge.rate) if buy_edge and buy_edge.rate > 0 else None
        sell = sell_edge.rate if sell_edge else None
        mid = rv.get(c)     # includes the poe2scout fallback threaded through ref_values
        edges = [e for e in (buy_edge, sell_edge) if e]
        kinds = {e.kind for e in edges}
        # Source label: prefer live/digest exchange data; a currency the exchange graph
        # doesn't cover is priced from poe2scout ("scout"); anything else valued only
        # via multi-hop is "derived".
        in_scout = bool(leaguehistory.scout_lookup(scout, c))
        source = ("live" if "live" in kinds else "digest" if "digest" in kinds
                  else "scout" if (not kinds and in_scout) else ("derived" if mid is not None else None))
        from_scout = source == "scout"
        age = min((e.age_s for e in edges), default=None)
        depth = next((len(e.ladder) for e in (sell_edge, buy_edge) if e and e.kind == "live"), None)
        spread = (buy - sell) if (buy is not None and sell is not None) else None
        spread_pct = (spread / mid * 100) if (spread is not None and mid) else None
        # Trend + %-change over the selected window (24h/3d/7d/14d). Digest is hourly;
        # poe2scout fallback is daily.
        hist = digest.pair_history(league, c, R, window_h)   # rate = R per c = price of c in R
        trend = [{"t": h["hour"], "v": h["rate"]} for h in hist]
        if len(trend) < 2:   # not on the exchange digest → draw from poe2scout dailies
            sh = leaguehistory.scout_lookup(scout_hist, c)
            if sh:
                cutoff = sh[-1]["t"] - window_h * 3600
                trend = [p for p in sh if p["t"] >= cutoff] or sh[-2:]
        # change over the window = latest vs the point at (or nearest before) the window start.
        change_pct = marketseries.change_over(trend, window_h * 3600)[1]
        # Default numeraire: the highest-VOLUME counterpart whose price stays readable.
        # Cheap currencies' biggest market is often Divine (huge value moves even on
        # modest flow), which would print a useless micro-price (Regal = 0.0034 div) — so
        # walk down the volume ranking and take the first counterpart the card is worth at
        # least ONE of. That is how prices are quoted by hand: a card is never shown in a
        # currency worth more than the card (a 0.5 floor once put Chaos "in Omen of Abyssal
        # Echoes" at 0.43 the hour that omen out-traded Exalted). Divine keeps its Chaos
        # market, omens keep Divine, Regal/Chaos/Vaal drop to Exalted. Currencies with no
        # liquid, readable market (poe2scout-only, or thin digest) tier by value instead.
        MIN_READABLE = 1.0   # numeraire units per 1 of the currency; below this, step down
        pref, seen = None, set()
        for _volr, other in ranked.get(c, ()):
            if other == c or other in seen:
                continue
            seen.add(other)
            nv = rv.get(other)
            if nv and mid and mid / nv >= MIN_READABLE:
                pref = other
                break
        if pref is None:
            mv, dv = rv.get("mirror"), rv.get("divine")
            if mid and mv and mid >= mv:
                pref = "mirror"
            elif mid and dv and mid >= dv:
                pref = "divine"
            else:
                pref = R
        # Universal rule: NOTHING is ever priced against itself (a 1:1 is useless).
        if pref == c:
            pref = "divine" if (c != "divine" and rv.get("divine")) else R
        rows.append({
            "id": c, "name": registry.name(c), "mid": mid, "buy": buy, "sell": sell,
            "spread": spread, "spread_pct": spread_pct, "source": source, "age_s": age,
            "depth": depth, "trend": trend, "change_pct": change_pct, "pref_num": pref,
            "hub": c in hub_ids,
        })
    rows.sort(key=lambda r: (r["mid"] is None, -(r["mid"] or 0)))   # most valuable first
    # Reference-currency price (R per unit) for every currency usable as a numeraire,
    # so the client can reprice any card into any of them. Reference itself is 1.
    need = {R} | {r["id"] for r in rows} | {r["pref_num"] for r in rows}
    prices = {i: (1.0 if i == R else rv.get(i)) for i in need if i == R or rv.get(i)}
    # Direct market rates for (card, numeraire) pairs. When a card is priced in a counterpart
    # that it trades against directly, the client shows THAT market's rate, not the cross of two
    # reference prices (which ignores the most liquid market on the card).
    pairs = g.pair_rates([r["id"] for r in rows], prices.keys())
    return {"reference": R, "league": league, "rows": rows, "prices": prices, "pairs": pairs,
            "session": session.status().get("connected", False)}


def board_pairs() -> list[tuple[str, str]]:
    s = get_settings()
    R = s["reference"]
    pairs = []
    for c in s["watchlist"]:
        if c != R:
            pairs.append((R, c))
            pairs.append((c, R))
    return pairs


def edge_table() -> list[dict]:
    g = graph.cached_graph()
    ref = g.ref_values()
    rows = []
    for (a, b), e in g.edges.items():
        rows.append({
            "from": a, "to": b, "from_name": registry.name(a), "to_name": registry.name(b),
            "kind": e.kind, "rate": e.rate, "age_s": e.age_s,
            "capacity_in": None if e.capacity_in() == INF else e.capacity_in(),
            "capacity_ref": None if e.capacity_ref(ref) == INF else e.capacity_ref(ref),
            "depth": len(e.ladder), "meta": e.meta,
        })
    rows.sort(key=lambda r: (r["from_name"], r["to_name"]))
    return rows
