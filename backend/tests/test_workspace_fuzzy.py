"""Fuzzy smoke test for the Trading workspace persistence contract.

The workspace file-tree (folders + saved searches, each with its own captured slug) is the
single source of truth and lives in user.sqlite under the `trading_workspace` kv key. This
test proves the save/load round-trip is LOSSLESS under fuzzing: many randomly-shaped trees
of unique items, each cycled save -> load -> (feed back) -> save 10x in a row, compared to
the original every cycle. Any drift or dropped field fails.

Run against a throwaway DATA_DIR so it never touches the user's real DB:

    DATA_DIR=$(mktemp -d) MARKET_SEED= .venv-build/bin/python -m pytest backend/tests/test_workspace_fuzzy.py -q
    # or standalone:  DATA_DIR=$(mktemp -d) python backend/tests/test_workspace_fuzzy.py
"""
import os
import random
import string
import sys
from pathlib import Path

# Import the REAL persistence layer (db.kv_get/kv_set do the exact production routing:
# `trading_workspace` -> user.sqlite, JSON-serialized). Requires DATA_DIR to be set to a
# temp dir by the caller; guard against clobbering a real install.
_dd = os.environ.get("DATA_DIR", "")
assert _dd and "Application Support" not in _dd, \
    "Set DATA_DIR to a temp dir (never the real install) before running this test"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import db  # noqa: E402

# A pool of distinct PoE2 item/base names; the generator draws WITHOUT replacement per tree
# so every search in a given tree is a genuinely unique item.
ITEM_POOL = [
    "Headhunter Heavy Belt", "Mageblood Heavy Belt", "Atziri's Acuity Moulded Mitts",
    "The Pariah", "Original Sin", "Melding of the Flesh", "Sublime Vision",
    "Progenesis Flask", "Ashes of the Stars", "Bottled Faith", "Squire Tower Shield",
    "Nimis Topaz Ring", "Defiance of Destiny", "Dawnbreaker", "Astramentis Amulet",
    "Ingenuity Belt", "Polcirkeln Sapphire Ring", "Grand Spectrum Diamond",
    "Sapphire Ring", "Ruby Ring", "Topaz Ring", "Emerald Ring", "Stellar Amulet",
    "Heavy Belt", "Sorcerer Boots", "Vaal Regalia", "Advanced Wand", "Expert Crossbow",
    "Attuned Wand", "Omen of Whittling", "Divine Orb", "Chaos Orb", "Exalted Orb",
    "Waystone Tier 15", "Tablet Precursor", "Simulacrum Splinter", "Breach Ring",
]
TYPES = ["search"]  # 'live' variants are captured as live=True on a search node


def _rand_slug(rng):
    # Real captured slugs are base64 of a gzipped query (start with the gzip header). Fuzz
    # both realistic and adversarial shapes: varied length, url-safe base64 alphabet.
    n = rng.randint(80, 200)
    alph = string.ascii_letters + string.digits + "-_"
    return "H4sIAAAAAAAA" + "".join(rng.choice(alph) for _ in range(n))


def _uid(rng):
    return "n_" + "".join(rng.choice(string.ascii_lowercase + string.digits) for _ in range(7))


def _make_search(rng, name):
    return {
        "id": _uid(rng), "kind": "search", "name": name,
        "auto": rng.choice([True, False]),
        "type": rng.choice(TYPES), "slug": _rand_slug(rng),
        "live": rng.choice([True, False]), "done": rng.choice([True, False]),
        "armed": rng.choice([True, False]),
        "notify": {"sound": rng.choice([True, False]),
                   "orb": rng.choice([True, False]),
                   "os": rng.choice([True, False])},
    }


def _make_folder(rng, children):
    return {"id": _uid(rng), "kind": "folder",
            "name": "📁 " + "".join(rng.choice(string.ascii_letters + " ") for _ in range(rng.randint(3, 12))).strip(),
            "open": rng.choice([True, False]), "children": children}


def _gen_tree(rng, names, depth, max_breadth):
    """Random forest: at each level a mix of leaf searches and nested folders, drawing unique
    item names from `names` (mutated as a stack) until exhausted."""
    out = []
    breadth = rng.randint(1, max_breadth)
    for _ in range(breadth):
        if not names:
            break
        make_folder = depth > 0 and rng.random() < 0.45
        if make_folder:
            kids = _gen_tree(rng, names, depth - 1, max_breadth)
            out.append(_make_folder(rng, kids))
        else:
            out.append(_make_search(rng, names.pop()))
    return out


def _all_search_ids(nodes):
    ids = []
    for n in nodes:
        if n["kind"] == "search":
            ids.append(n["id"])
        for c in n.get("children", []) or []:
            ids.extend(_all_search_ids([c]))
    return ids


def _count(nodes):
    return sum(1 + _count(n.get("children", []) or []) for n in nodes)


def _gen_doc(rng):
    names = ITEM_POOL[:]
    rng.shuffle(names)
    tree = _gen_tree(rng, names, depth=rng.randint(1, 4), max_breadth=5)
    sids = _all_search_ids(tree)
    return {
        "version": 2,
        "tree": tree,
        "layout": None,
        "openTabs": rng.sample(sids, min(len(sids), rng.randint(0, 3))),
        "activeId": rng.choice(sids) if sids else None,
    }


def _roundtrip_10x(doc):
    """Save -> load -> feed the load back in -> save ... 10 cycles. Compare to the ORIGINAL
    each cycle so any cumulative drift is caught, not just single-hop loss."""
    import copy
    original = copy.deepcopy(doc)
    cur = doc
    for cycle in range(1, 11):
        db.kv_set("trading_workspace", cur)
        got = db.kv_get("trading_workspace")
        assert got == original, f"cycle {cycle}: workspace drifted from original"
        # activeId must still resolve to a real search node after the round-trip.
        if original["activeId"] is not None:
            assert original["activeId"] in _all_search_ids(got["tree"]), \
                f"cycle {cycle}: activeId lost from tree"
        cur = got  # the reloaded doc is the next thing we persist (rerender -> save)
    return _count(original["tree"])


def test_workspace_fuzzy_roundtrip():
    rng = random.Random(1337)  # fixed seed -> reproducible failures
    total_nodes = 0
    trees = 25
    for t in range(trees):
        doc = _gen_doc(rng)
        total_nodes += _roundtrip_10x(doc)
    # Sanity: we actually exercised a meaningful amount of structure.
    assert total_nodes > 100, f"generator produced too little structure ({total_nodes} nodes)"
    print(f"OK: {trees} fuzzy trees x 10 round-trips each, {total_nodes} total nodes, zero data loss")


if __name__ == "__main__":
    test_workspace_fuzzy_roundtrip()
    print("PASS")
