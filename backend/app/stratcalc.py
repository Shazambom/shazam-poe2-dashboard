"""Strategy → Strat Calculator: named farming strats and each one's profit in divines per hour.

The math, the wall-clock timers and the strats' lifecycle live in the view
(frontend/src/lib/stratcalc.js). The backend owns two things:
  * the saved strats — the user kv `strat_calc` (user.sqlite), checked on the way in so a bad write
    can never replace a good calculator;
  * the price table they are valued with — divines per unit of every currency, read off the ONE
    value table every screen prices from (Graph.values). That covers everything the currency picker
    offers, lineage support gems included (the graph falls back to poe2scout for what the exchange
    doesn't trade).
"""
from __future__ import annotations

import json

import math

KEY = "strat_calc"
VERSION = 1         # the view's document version (frontend/src/lib/stratcalc.js VERSION)
MAX_STRATS = 500    # far above any history; low enough that a runaway client can't bloat kv
MAX_ROWS = 200      # per list
MAX_ID = 120        # a trade id, a strat id, a name
MAX_TABLETS = 4     # slots on a map (three, four in a city)
MAX_DEPTH = 8       # folders inside folders in the sidebar tree


def divine_prices(values: dict[str, float], reference: str) -> dict[str, float]:
    """Divines per unit of each valued currency. Empty when divine itself has no value (a cold
    graph): a calculator priced in a unit that has no price would show nonsense."""
    V = {**values, reference: 1.0}
    div = V.get("divine")
    if not div or div <= 0:
        return {}
    return {c: v / div for c, v in V.items() if v and v > 0}


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0


def _count(v) -> bool:
    return _num(v) and float(v).is_integer()


def _str(v) -> bool:
    return isinstance(v, str) and 0 < len(v) <= MAX_ID


def _rows(rows) -> bool:
    if not isinstance(rows, list) or len(rows) > MAX_ROWS:
        return False
    for r in rows:
        if not isinstance(r, dict) or not _count(r.get("qty")):
            return False
        cur, name, price = r.get("cur"), r.get("name"), r.get("price")
        if not ((_str(cur) and name is None) or (cur is None and _str(name))):
            return False
        if price is not None and not _num(price):
            return False
        # a unique (a named row with its base) may carry the price floor its trade search found
        base, floor = r.get("base"), r.get("floor")
        if base is not None and not (cur is None and _str(base)):
            return False
        if floor is not None and not (base is not None and isinstance(floor, dict)
                                      and _num(floor.get("div")) and _num(floor.get("at"))):
            return False
    return True


MAX_QUERY = 20_000   # characters of a linked trade search: the site's filters, never a payload


def _link(k) -> bool:
    """A tablet line's linked trade search: {query: the site's search body, league, div | null, at}."""
    if not (isinstance(k, dict) and isinstance(k.get("query"), dict) and isinstance(k["query"].get("query"), dict)
            and _str(k.get("league")) and (k.get("div") is None or _num(k.get("div"))) and _num(k.get("at"))):
        return False
    return len(json.dumps(k["query"])) <= MAX_QUERY


def _tablets(tb) -> bool:
    """The tablet setup: lines of one tablet each (a unique's name and base, a base, or neither for
    any normal tablet), MAX_TABLETS slots in all."""
    lines = tb.get("lines") if isinstance(tb, dict) else None
    if not isinstance(lines, list):
        return False
    ids, slots = set(), 0
    for l in lines:
        if not (isinstance(l, dict) and _str(l.get("id")) and l["id"] not in ids and _count(l.get("slots")) and l["slots"] >= 1
                and (l.get("price") is None or _num(l.get("price"))) and _str(l.get("cur"))
                and all(l.get(k) is None or _str(l.get(k)) for k in ("base", "name"))
                and ("link" not in l or _link(l["link"]))):
            return False
        ids.add(l["id"])
        slots += l["slots"]
    return slots <= MAX_TABLETS


def _strat(s) -> str | None:
    if not isinstance(s, dict) or not _str(s.get("id")) or not _str(s.get("name")):
        return "a strat has an id and a name"
    if not _num(s.get("updatedAt", 0)):
        return "a strat's last edit is a time"
    t = s.get("timer")
    if not isinstance(t, dict) or not _num(t.get("elapsedMs")) or not (t.get("startedAt") is None or _num(t.get("startedAt"))):
        return "timer is {startedAt: time | null, elapsedMs}"
    tm = s.get("time")
    if tm is not None and not (isinstance(tm, dict) and isinstance(tm.get("on"), bool) and _num(tm.get("ms"))):
        return "time is {on, ms}: the session's length typed by hand"
    if not (_rows(s.get("loot")) and _rows(s.get("fixed"))):
        return f"loot and fixed are at most {MAX_ROWS} rows of {{cur | name (+ base, floor), whole qty, price | null}}"
    m, tb, o = s.get("maps"), s.get("tablets"), s.get("override")
    if not (isinstance(m, dict) and _count(m.get("count")) and (m.get("price") is None or _num(m.get("price"))) and _str(m.get("cur"))
            and ("link" not in m or _link(m["link"]))):
        return "maps is {whole count, price | null, cur, link?}"
    if not _tablets(tb):
        return f"tablets is {{lines: [{{id, base | null, name | null, slots ≥ 1, price, cur}}]}}, {MAX_TABLETS} slots in all"
    if not (isinstance(o, dict) and isinstance(o.get("on"), bool) and _num(o.get("amount")) and _str(o.get("cur"))):
        return "override is {on, amount, cur}"
    return None


def validate(calc) -> str | None:
    """None when `calc` is the document the view writes, else why not. Refuses rather than repairs:
    the view only ever sends this shape, so anything else is a bug that should be loud."""
    if not isinstance(calc, dict) or calc.get("v") != VERSION:
        return f"calc must be a version-{VERSION} calculator"
    if not (calc.get("active") is None or _str(calc.get("active"))) or not _str(calc.get("lastCur")):
        return "active is a strat id or null; lastCur a currency"
    strats = calc.get("strats")
    if not isinstance(strats, list) or len(strats) > MAX_STRATS:
        return f"strats is a list of at most {MAX_STRATS}"
    seen = set()
    for s in strats:
        err = _strat(s)
        if err:
            return err
        if s["id"] in seen:
            return f"two strats share the id {s['id']!r}"
        seen.add(s["id"])
    return None if calc.get("tree") is None else _tree(calc["tree"], seen)


def _tree(tree, strat_ids: set) -> str | None:
    """The sidebar: folders (named, nested at most MAX_DEPTH) and strats, each strat at most once."""
    placed: set = set()

    def walk(nodes, depth) -> str | None:
        if not isinstance(nodes, list) or depth > MAX_DEPTH:
            return f"the tree is lists of folders and strats, at most {MAX_DEPTH} folders deep"
        for n in nodes:
            if not isinstance(n, dict) or not _str(n.get("id")) or n["id"] in placed:
                return "every tree entry has its own id"
            placed.add(n["id"])
            if n.get("kind") == "strat":
                if n["id"] not in strat_ids:
                    return f"the tree places a strat that isn't there: {n['id']!r}"
            elif n.get("kind") == "folder":
                if n["id"] in strat_ids or not _str(n.get("name")) or not isinstance(n.get("open", True), bool):
                    return "a folder has its own id and a name"
                err = walk(n.get("children"), depth + 1)
                if err:
                    return err
            else:
                return "a tree entry is a folder or a strat"
        return None

    return walk(tree, 0)
