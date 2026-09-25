"""The mod-pool tables for Trading → Mods (docs/mods-page-design.md).

What can roll on every item type, in every pool a currency opens on it, derived from the game
data with nothing hand-listed: the RePoE PoE2 export (mods, base items, item classes, the
socketables) and poe2db's currency pages (the orbs with a minimum modifier level, the essences
and alloys and what they force). A new patch's data lands in the tables by running `refresh()`
again; the rules below are the game's rules, not a table of its facts.

The pipeline: `refresh()` runs on shazam before the seed is published (a CLI entry the cron
calls), fetches through the gateway with the same on-disk cache the gold-fee loader uses, and
writes `mod_pools` / `mod_currencies` (market tables in `datapolicy.SEED_TABLES`, so every
install gets them with the seed) and a `mods_meta` watermark in kv_ops. Desktop installs never
fetch; the endpoints only read.

Derivations, each one a rule the export supports:
- An item class's pool domain is the mod domain its released bases' tags reach under the
  first-matching-spawn-weight rule (jewels → misc, flasks → flask, waystones → area, ...). A class
  nothing rolls on is not a pool. Logbooks are the one class whose bases carry no spawn tag: their
  pool is everything their domain uses.
- A pool is one class × one spawn-tag set (poe2db's class × attribute unit), named from its
  attribute tags, its bases' shared stem plus a numeric range, or its bases.
- A section (a pool another currency opens) is every spawn tag no released base carries: the
  socketable whose text says "Can roll X modifiers" is its carrier (title and classes); a key whose
  mods carry base tags (the bones, the Genesis Tree) needs none; a key with neither would show on
  every item and is skipped. Corruption implicits and their upgrades (the `upgraded_corruption_mod`
  tag) are two more. The orb's minimum modifier level applies where regular orbs roll: item-domain
  prefix/suffix pools.
"""
from __future__ import annotations

import asyncio
import html as html_lib
import json
import logging
import re
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from . import db, gamedata, gateway

log = logging.getLogger("poe2arb.modpool")

REPOE = "https://repoe-fork.github.io/poe2/"
REPOE_FILES = ("mods.json", "base_items.json", "item_classes.json", "augments.min.json")
POE2DB = "https://poe2db.tw/us/"
AFFIXES = ("prefix", "suffix", "corrupted", "enchant")
# Tags that group families for the game's bookkeeping, never worth a chip.
GENERIC_TAGS = frozenset({"resource", "drop", "default", "unveiled_mod", "upgraded_corruption_mod"})
# The one class whose bases carry no spawn tag: a logbook rolls its areas' mods. Keyed by the
# class's display name, since the export lists two logbook classes under one name.
DOMAIN_OVERRIDES = {"Expedition Logbooks": "expedition_relic"}
# PoE1 leftovers the export still carries with released bases and a category. A class with no
# category at all (hidden items) is not an item class and needs no listing.
LEGACY_CLASSES = frozenset({"FishingRod", "MemoryLine", "HeistEquipmentWeapon", "HeistEquipmentTool", "HeistEquipmentUtility", "HeistEquipmentReward"})
# Socketable target phrases that name a group rather than classes. Armour and the martial weapons
# are read off base tags; the caster weapons and jewellery carry no shared tag.
CASTER = ("Wand", "Staff", "Sceptre")
JEWELLERY = ("Ring", "Amulet", "Belt", "Quiver")

state: dict = {"loaded_at": None, "last_error": None, "pools": 0, "source": None}


@dataclass
class Export:
    mods: dict
    bases: dict
    classes: dict
    augments: dict


@dataclass
class Derived:
    pools: list = field(default_factory=list)
    families: list = field(default_factory=list)
    sections: list = field(default_factory=list)


# ------------------------------------------------------------------ text rules
_MARKUP_PAIR = re.compile(r"\[([^\]|]*)\|([^\]]*)\]")
_MARKUP_ONE = re.compile(r"\[([^\]]*)\]")
_RANGE = re.compile(r"\((-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)\)")
_NUMBER = re.compile(r"\(-?\d+(?:\.\d+)?--?\d+(?:\.\d+)?\)|\d+(?:\.\d+)?")


def strip_markup(text: str) -> str:
    """The game's [keyword|display] markup: the printed side."""
    return _MARKUP_ONE.sub(r"\1", _MARKUP_PAIR.sub(r"\2", text))


def family_text(text: str) -> str:
    """Every number and range → #, so a family's tiers share one text."""
    return _NUMBER.sub("#", text)


def tier_text(text: str) -> str:
    return _RANGE.sub(r"(\1–\2)", text)


def slug(s: str) -> str:
    return re.sub(r"^_|_$", "", re.sub(r"[^a-z0-9]+", "_", s.lower()))


def label(tag: str) -> str:
    """A tag as a chip or a title: ulaman_mod → Ulaman, genesis_tree_caster → Genesis Tree Caster."""
    words = [w for w in tag.split("_") if w != "mod"]
    return " ".join(w.capitalize() for w in words)


# ------------------------------------------------------------------ the export's rules
def rolls_on(weights: list, tags: set) -> bool:
    """RePoE's rule: the first spawn-weight tag the item carries decides. Weights are the
    export's {tag, weight} dicts or this module's [tag, weight] pairs."""
    for w in weights:
        tag, weight = (w["tag"], w["weight"]) if isinstance(w, dict) else (w[0], w[1])
        if tag in tags:
            return weight > 0
    return False


def plural_index(classes: dict) -> dict:
    """Every way a socketable's target names a class → the class's display name."""
    idx = {}
    for cid, c in classes.items():
        name = c.get("name") or cid
        idx[cid] = name
        idx[name] = name
        for single in singulars(name):
            idx[single] = name
    return idx


def singulars(plural: str) -> list:
    """The singular forms a plural class name can take: Staves → Staff, Rings → Ring, Foci → Focus."""
    out = []
    if plural.endswith("ves"):
        out.append(plural[:-3] + "ff")
        out.append(plural[:-3] + "f")
    if plural.endswith("i"):
        out.append(plural[:-1] + "us")
    if plural.endswith("s"):
        out.append(plural[:-1])
    return out


def _class_tags(export: Export) -> dict:
    """Class id → the union of its released bases' tags."""
    out = defaultdict(set)
    for b in export.bases.values():
        if b.get("release_state") == "released":
            out[b.get("item_class")].update(b.get("tags") or [])
    return out


def classes_of(target, plural: dict, export: Export) -> list:
    """A socketable's target (a class list, or a phrase such as "Wand or Staff") → class names.
    An unknown phrase is dropped with a warning; the nightly build never fails on a new word."""
    if isinstance(target, list):
        return [plural.get(t, t) for t in target]
    ctags = _class_tags(export)
    armour = [plural[c] for c, t in ctags.items() if "armour" in t and c in plural]
    martial = [plural[c] for c, t in ctags.items() if "weapon" in t and c in plural]
    caster = [plural[c] for c in CASTER if c in plural]
    jewellery = [plural[c] for c in JEWELLERY if c in plural]
    groups = {"Martial Weapon": martial, "Caster Weapon": caster, "Weapon": martial + caster, "Armour": armour,
              "All Equipment": armour + martial + caster + jewellery}
    out = []
    for part in re.split(r",\s*|\s+(?:or|and)\s+", strip_markup(target)):
        p = part.strip()
        if p in groups:
            out.extend(groups[p])
        elif p in plural:
            out.append(plural[p])
        else:
            log.warning("modpool: unknown socketable target %r in %r; dropped", p, target)
    seen = set()
    return [c for c in out if not (c in seen or seen.add(c))]


# ------------------------------------------------------------------ pools
_ATTR = re.compile(r"^((?:str|dex|int)(?:_(?:str|dex|int))*)_(?:armour|shield|special_relic)$")
_TIER_IN_NAME = re.compile(r"\(Tier (\d+)\)")


def _attrs(tags) -> list | None:
    for t in tags:
        m = _ATTR.match(t)
        if m:
            return [a.capitalize() for a in m.group(1).split("_")]
    return None


def pool_name(class_name: str, tags: list, bases: list, split: bool) -> str:
    """A pool's display name, a function of its identity and nothing else."""
    attrs = _attrs(tags)
    if attrs:
        return f"{class_name} · {'/'.join(attrs)}"
    if not split:
        return class_name
    tiers = sorted(int(m.group(1)) for n in bases for m in [_TIER_IN_NAME.search(n)] if m)
    if tiers and len(tiers) == len(bases):
        return f"{class_name} · T{tiers[0]}" + (f"–{tiers[-1]}" if tiers[-1] != tiers[0] else "")
    words = [n.split(" ") for n in bases]
    last = words[0][-1]
    shared = all(len(w) > 1 and w[-1] == last for w in words) and (len(words) > 1 or last == class_name or last in singulars(class_name))
    short = sorted(" ".join(w[:-1]) for w in words) if shared else sorted(bases)
    head = ", ".join(short[:3])
    return f"{class_name} · {head}" + (f" +{len(short) - 3}" if len(short) > 3 else "")


def _spawn_tags_by_domain(mods: dict) -> dict:
    """Every tag a domain's mods key on, at any weight: a zero says as much as a one under the
    first-match rule (a Bone Wand's no_fire_spell_mods shuts the fire spell families)."""
    out = defaultdict(set)
    for m in mods.values():
        if m.get("generation_type") in ("prefix", "suffix"):
            for w in m.get("spawn_weights") or []:
                out[m["domain"]].add(w["tag"])
    return out


def _domain_of(class_tags: set, mods: dict) -> str | None:
    """The mod domain a class's bases reach: the domain of most mods that roll on its tags and
    do not roll on anything (a mod keyed on `default` alone says nothing about the class)."""
    counts = Counter()
    for m in mods.values():
        if m.get("generation_type") not in ("prefix", "suffix"):
            continue
        w = m.get("spawn_weights") or []
        if rolls_on(w, class_tags) and not rolls_on(w, {"default"}):
            counts[m["domain"]] += 1
    return counts.most_common(1)[0][0] if counts else None


def pools_from(export: Export) -> list:
    spawn_tags = _spawn_tags_by_domain(export.mods)
    # Classes are grouped by display name: two class ids with one name are one thing to the user.
    by_name: dict = {}
    for b in export.bases.values():
        cid = b.get("item_class")
        if b.get("release_state") != "released" or not cid or cid in LEGACY_CLASSES:
            continue
        cls = export.classes.get(cid, {})
        if not cls.get("category"):
            continue
        entry = by_name.setdefault(cls.get("name") or cid, {"cid": cid, "bases": []})
        entry["bases"].append(b)
    # Two classes whose released bases are the same items (the export's two logbook classes) are
    # one thing: keep the name the overrides know, else the first.
    by_bases: dict = {}
    for name, entry in list(by_name.items()):
        key = tuple(sorted((b["name"], tuple(sorted(b.get("tags") or []))) for b in entry["bases"]))
        other = by_bases.get(key)
        if other and other != name:
            keep, drop = (name, other) if name in DOMAIN_OVERRIDES else (other, name)
            by_name.pop(drop, None)
            by_bases[key] = keep
        else:
            by_bases[key] = name
    pools = []
    for class_name, entry in by_name.items():
        cid, bases = entry["cid"], entry["bases"]
        class_tags = set(t for b in bases for t in b.get("tags") or [])
        domain = DOMAIN_OVERRIDES.get(class_name) or _domain_of(class_tags, export.mods)
        if not domain:
            continue
        spawn = spawn_tags[domain]
        groups = defaultdict(list)
        for b in bases:
            tags = tuple(sorted(set(b.get("tags") or []) & spawn))
            if class_name in DOMAIN_OVERRIDES:   # a logbook: every tag its domain's mods roll on
                tags = tuple(sorted(set(w["tag"] for m in export.mods.values() if m.get("domain") == domain for w in m.get("spawn_weights") or [] if w["weight"] > 0) - {"default"}))
            groups[tags].append(b["name"])
        variants = [(list(t), sorted(set(n))) for t, n in groups.items() if t]
        if any(_attrs(t) for t, _ in variants):   # the attribute-less golden bases are unique-only
            variants = [(t, n) for t, n in variants if _attrs(t)]
        split = len(variants) > 1 and not any(_attrs(t) for t, _ in variants)
        big = max(variants, key=lambda v: len(v[1])) if split else None
        generic = big if big and len(big[1]) >= 3 and all(v is big or len(big[1]) > 2 * len(v[1]) for v in variants) else None
        for tags, names in variants:
            attrs = _attrs(tags)
            name = class_name if (tags, names) == generic else pool_name(class_name, tags, names, split)
            if attrs:
                pid = f"{slug(cid)}_{'_'.join(a.lower() for a in attrs)}"
            elif not split or (tags, names) == generic:
                pid = slug(cid)
            else:
                pid = f"{slug(cid)}_{slug(name.split(' · ', 1)[1])}"
            if any(p["id"] == pid for p in pools):   # two tag sets with the same attributes: the bases tell them apart
                pid = f"{pid}_{slug(names[0])}"
            pools.append({"id": pid, "name": name, "class": class_name, "domain": domain, "tags": tags, "keywords": names})
    # A pool nothing rolls on is not a pool (sanctified relics, junk classes).
    fams = families_from(export)
    keep = []
    for p in pools:
        tags = set(p["tags"])
        if any(f["domain"] == p["domain"] and f["affix"] in ("prefix", "suffix") and any(rolls_on(t["weights"], tags) for t in f["tiers"]) for f in fams):
            keep.append(p)
        else:
            log.info("modpool: nothing rolls on %s; not a pool", p["id"])
    ids = [p["id"] for p in keep]
    if len(set(ids)) != len(ids):
        raise ValueError(f"pool ids collide: {[i for i in ids if ids.count(i) > 1]}")
    return sorted(keep, key=lambda p: (p["class"], p["name"]))


# ------------------------------------------------------------------ families
def primary_tags(tags, universe: set, freq: Counter) -> list:
    """The tags worth a chip: no bookkeeping tag, no compound whose part is itself a tag
    (elemental_damage beside elemental and damage); rarest first, so a family's chips are its
    most specific."""
    out = [t for t in set(tags) if t not in GENERIC_TAGS and not ("_" in t and any(p in universe for p in t.split("_")))]
    return sorted(out, key=lambda t: (freq.get(t, 0), t))


def _base_tags(export: Export) -> set:
    return set(t for b in export.bases.values() if b.get("release_state") == "released" for t in b.get("tags") or [])


def families_from(export: Export) -> list:
    """Every family that can land on some pool: prefix/suffix/corrupted mods of every pool domain,
    the corruption upgrades, and the desecrated-domain mods keyed on a tag no base carries."""
    domains = set(DOMAIN_OVERRIDES.values())
    class_tags = _class_tags(export)
    for cid, tags in class_tags.items():
        d = _domain_of(tags, export.mods)
        if d:
            domains.add(d)
    carried = _base_tags(export)
    by_key: dict = {}
    for mid, m in export.mods.items():
        weights = [[w["tag"], w["weight"]] for w in m.get("spawn_weights") or []]
        if not m.get("text") or not any(w > 0 for _, w in weights):
            continue
        affix = m.get("generation_type")
        implicit = m.get("implicit_tags") or []
        if m.get("domain") in domains and affix in ("prefix", "suffix", "corrupted") and not m.get("is_essence_only"):
            pass
        elif m.get("domain") == "item" and affix == "unique" and "upgraded_corruption_mod" in implicit:
            affix = "enchant"
        elif m.get("domain") == "desecrated" and affix in ("prefix", "suffix") and any(w > 0 and t not in carried for t, w in weights):
            pass
        else:
            continue
        text = strip_markup(m["text"])
        group = (m.get("groups") or [None])[0] or m.get("type") or mid
        key = (m["domain"], affix, group, family_text(text))
        fam = by_key.setdefault(key, {"affix": affix, "domain": m["domain"], "group": group, "text": family_text(text), "tags": set(), "tiers": []})
        fam["tags"].update(implicit)
        fam["tiers"].append({"id": mid, "name": m.get("name") or "", "ilvl": int(m.get("required_level") or 0), "text": tier_text(text), "weights": weights})
    universe, freq = set(), Counter()
    for f in by_key.values():
        for t in f["tags"]:
            universe.add(t)
            freq[t] += 1
    seen = Counter()
    out = []
    for f in by_key.values():
        base = f"{f['affix']}:{f['group']}" + ("" if f["domain"] == "item" else f"@{f['domain']}")
        seen[base] += 1
        fid = base if seen[base] == 1 else f"{base}#{seen[base]}"
        out.append({"id": fid, "affix": f["affix"], "domain": f["domain"], "group": f["group"], "text": f["text"],
                    "tags": primary_tags(f["tags"], universe, freq),
                    "tiers": sorted(f["tiers"], key=lambda t: (-t["ilvl"], t["id"]))})
    return out


# ------------------------------------------------------------------ sections (derived)
_CAN_ROLL = re.compile(r"Can roll (\w+) modifiers", re.I)


def sections_from(export: Export, families: list) -> list:
    carried = _base_tags(export)
    plural = plural_index(export.classes)
    # Carriers: a socketable whose text names the pool it opens.
    carriers = {}
    for mid, a in export.augments.items():
        for c in (a.get("categories") or {}).values():
            for t in c.get("stat_text") or []:
                m = _CAN_ROLL.search(strip_markup(t))
                if m:
                    carriers[m.group(1).lower()] = (export.bases.get(mid, {}).get("name") or mid.split("/")[-1], classes_of(c.get("target"), plural, export))
    keyed: dict = defaultdict(list)   # key tag → the (family, tier) pairs keyed on it
    for f in families:
        if f["affix"] not in ("prefix", "suffix"):
            continue
        for t in f["tiers"]:
            for tag, w in t["weights"]:
                if w > 0 and tag not in carried:
                    keyed[tag].append((f, t))
    sections = [{"id": "base", "title": None, "domain": None, "affixes": ["prefix", "suffix"], "keys": [], "classes": None, "floored": True}]
    for tag, pairs in sorted(keyed.items()):
        domain = Counter(f["domain"] for f, _ in pairs).most_common(1)[0][0]
        if tag in carriers:
            title, classes = carriers[tag]
        elif any(t in carried and t != "default" for _, tier in pairs for t, _w in tier["weights"]):
            # The key's own mods name base tags (at any weight), so the bases restrict where it lands.
            title, classes = label(tag), None
        else:
            log.info("modpool: key %s has no carrier and no base tag; skipped", tag)
            continue
        sections.append({"id": tag, "title": title, "domain": domain, "affixes": ["prefix", "suffix"], "keys": [tag], "classes": classes, "floored": domain == "item"})
    for affix, title in (("corrupted", "Corrupted"), ("enchant", "Corrupted upgrade")):
        if any(f["affix"] == affix for f in families):
            sections.append({"id": affix, "title": title, "domain": "item", "affixes": [affix], "keys": [], "classes": None, "floored": False})
    return sections


def _keys_on(family: dict, keys: list) -> bool:
    return not keys or any(w > 0 and t in keys for tier in family["tiers"] for t, w in tier["weights"])


def build_pool(pool: dict, families: list, sections: list) -> dict:
    """One item type's pools, precomputed for the client: no spawn weights leave here."""
    out = []
    for s in sections:
        if s["id"] != "base" and pool["domain"] != "item":
            continue
        if s["classes"] is not None and pool["class"] not in s["classes"]:
            continue
        tags = set(pool["tags"]) | set(s["keys"])
        domain = s["domain"] or pool["domain"]
        sec = {"id": s["id"], "title": s["title"], "floored": s["floored"]}
        for a in s["affixes"]:
            sec[a] = []
        for f in families:
            if f["domain"] != domain or f["affix"] not in s["affixes"] or not _keys_on(f, s["keys"]):
                continue
            tiers = [t for t in f["tiers"] if rolls_on(t["weights"], tags)]
            if not tiers:
                continue
            sec[f["affix"]].append({"id": f["id"], "text": f["text"], "tags": list(f["tags"]),
                                    "tiers": [{"tier": i + 1, "name": t["name"], "ilvl": t["ilvl"], "text": t["text"]} for i, t in enumerate(tiers)]})
        if s["id"] == "base" or any(sec[a] for a in s["affixes"]):
            out.append(sec)
    count = Counter(t for a in ("prefix", "suffix") for f in out[0].get(a, []) for t in f["tags"])
    chips = sorted(({"id": t, "label": label(t), "count": n} for t, n in count.items()), key=lambda c: (-c["count"], c["id"]))
    return {"sections": out, "tags": chips}


def derive(export: Export) -> Derived:
    families = families_from(export)
    return Derived(pools=pools_from(export), families=families, sections=sections_from(export, families))


# ------------------------------------------------------------------ poe2db pages
_ITEM = re.compile(r'<a class="item_currency[^"]*"[^>]*href="([^"]+)"[^>]*>(?:<img[^>]*/>)?([^<]+)</a>(.*?)(?=<a class="item_currency|$)', re.S)
_LEVEL = re.compile(r"(Minimum Modifier Level|Maximum Item Level)</a>:\s*<span[^>]*>(\d+)</span>")
_TABLE = re.compile(r"<table[^>]*>.*?<th>Class</th><th>Modifier</th><th>Pre/Suf</th><th>Required Level</th>.*?<tbody[^>]*>(.*?)</tbody>", re.S)
_ROW = re.compile(r"<tr>(.*?)</tr>", re.S)
_CELL = re.compile(r"<td>(.*?)</td>", re.S)
_TAGS = re.compile(r"<[^>]+>")


def _text(fragment: str) -> str:
    t = html_lib.unescape(_TAGS.sub("", fragment))
    return re.sub(r"\s+", " ", t.replace("—", "–")).replace("( ", "(").replace(" )", ")").replace(" %", "%").replace(" ,", ",").strip()


def currencies_from(page: str) -> list:
    """Every currency on poe2db's stackable list with a Minimum Modifier Level or a Maximum Item Level."""
    out, seen = [], set()
    for slug_, name, body in _ITEM.findall(page):
        name = html_lib.unescape(name).strip()
        if not name or name in seen:
            continue
        levels = {k: int(v) for k, v in _LEVEL.findall(body)}
        if not levels:
            continue
        seen.add(name)
        out.append({"id": slug_.lower().replace("_", "-"), "name": name, "floor": levels.get("Minimum Modifier Level", 0), "cap": levels.get("Maximum Item Level")})
    return out


def grant_slugs(page: str) -> list:
    """The currencies whose text says they add a guaranteed modifier: their pages carry the table."""
    out, seen = [], set()
    for slug_, name, body in _ITEM.findall(page):
        name = html_lib.unescape(name).strip()
        if name and name not in seen and "guaranteed modifier" in _text(body):
            seen.add(name)
            out.append((slug_, name))
    return out


def grant_from(name: str, page: str) -> dict | None:
    """What a currency forces per item class, from its page's Class / Modifier / Pre-Suf / Level table."""
    m = _TABLE.search(page)
    if not m:
        return None
    rows = []
    for row in _ROW.findall(m.group(1)):
        cells = [_text(c) for c in _CELL.findall(row)]
        if len(cells) < 4:
            continue
        rows.append({"class": cells[0], "text": cells[1], "affix": cells[2].lower(), "level": int(cells[3]) if cells[3].isdigit() else 0})
    kind = "alloy" if "Alloy" in name else "essence"
    tier = 0 if name.startswith("Lesser ") else 2 if name.startswith("Greater ") else 3 if name.startswith("Perfect ") else 1
    return {"name": name, "kind": kind, "tier": tier, "rows": rows}


# ------------------------------------------------------------------ assembly and storage
def _augments(export: Export, plural: dict) -> list:
    out = []
    for mid, a in export.augments.items():
        fits = []
        for c in (a.get("categories") or {}).values():
            classes = classes_of(c.get("target"), plural, export)
            text = [strip_markup(t) for t in c.get("stat_text") or []]
            bonded = [strip_markup(t) for t in c.get("bonded_stat_text") or []]
            if classes and (text or bonded):
                fits.append({"classes": classes, "text": text, "bonded": bonded})
        name = export.bases.get(mid, {}).get("name") or mid.split("/")[-1]
        if fits:
            out.append({"id": slug(mid.split("/")[-1]), "name": name, "type": strip_markup(a.get("type_name") or ""), "level": a.get("required_level"), "fits": fits})
    return sorted(out, key=lambda a: a["name"])


def assemble(derived: Derived, export: Export | None = None, currencies: list | None = None, grants: list | None = None, source: dict | None = None) -> dict:
    """Everything the tables hold: per pool its sections, chips and grants; the currencies; the watermark."""
    grants = [g for g in grants or [] if g]
    augments = _augments(export, plural_index(export.classes)) if export else []
    pools = []
    for p in derived.pools:
        built = build_pool(p, derived.families, derived.sections)
        cls = p["class"]
        ess = [{**g, "rows": [r for r in g["rows"] if r["class"] == cls]} for g in grants]
        ess = [g for g in ess if g["rows"]]
        ess.sort(key=lambda g: (g["tier"], g["name"]))
        aug = []
        for a in augments:
            fits = [f for f in a["fits"] if cls in f["classes"]]
            if fits:
                aug.append({"id": a["id"], "name": a["name"], "type": a["type"], "level": a["level"],
                            "text": sorted(set(t for f in fits for t in f["text"]), key=lambda t: [f["text"].index(t) if t in f["text"] else 0 for f in fits]),
                            "bonded": [t for f in fits for t in f["bonded"]]})
        order = {"Rune": 0, "Soul Core": 1, "Idol": 2}
        aug.sort(key=lambda a: (order.get(a["type"], 9), a["name"]))
        pools.append({**p, "data": {"sections": built["sections"], "tags": built["tags"],
                                    "grants": {"essences": [g for g in ess if g["kind"] == "essence"], "alloys": [g for g in ess if g["kind"] == "alloy"], "augments": aug}}})
    return {"pools": pools, "currencies": currencies or [], "meta": {"built_at": time.time(), "source": source or {}, "pools": len(pools), "families": len(derived.families)}}


def store(result: dict) -> None:
    with db.tx() as c:
        c.execute("DELETE FROM mod_pools")
        c.executemany("INSERT INTO mod_pools(id, name, class, domain, keywords, data) VALUES (?,?,?,?,?,?)",
                      [(p["id"], p["name"], p["class"], p["domain"], json.dumps(p["keywords"]), json.dumps(p["data"], separators=(",", ":"))) for p in result["pools"]])
        c.execute("DELETE FROM mod_currencies")
        c.executemany("INSERT INTO mod_currencies(id, name, floor, cap) VALUES (?,?,?,?)",
                      [(x["id"], x["name"], x["floor"], x["cap"]) for x in result["currencies"]])
    db.kv_set("mods_meta", result["meta"])
    state.update(loaded_at=time.time(), pools=len(result["pools"]), last_error=None, source=result["meta"].get("source"))


# ------------------------------------------------------------------ reads (endpoints)
def pools() -> list:
    with db.q() as c:
        rows = c.execute("SELECT id, name, class, domain, keywords FROM mod_pools ORDER BY class, name").fetchall()
    return [{"id": r["id"], "name": r["name"], "class": r["class"], "domain": r["domain"], "keywords": json.loads(r["keywords"])} for r in rows]


def pool(pool_id: str) -> dict | None:
    with db.q() as c:
        r = c.execute("SELECT id, name, class, domain, data FROM mod_pools WHERE id = ?", (pool_id,)).fetchone()
    if not r:
        return None
    return {"id": r["id"], "name": r["name"], "class": r["class"], "domain": r["domain"], **json.loads(r["data"])}


def currencies() -> list:
    with db.q() as c:
        rows = c.execute("SELECT id, name, floor, cap FROM mod_currencies ORDER BY rowid").fetchall()
    return [{"id": r["id"], "name": r["name"], "floor": r["floor"], "cap": r["cap"]} for r in rows]


# ------------------------------------------------------------------ refresh (shazam's cron)
async def _page(slug_: str, max_age: int) -> str:
    """A poe2db page, cached beside the gold-fee tables (these are HTML on purpose, so the data
    loader's HTML guard does not apply)."""
    path = gamedata.CACHE / f"poe2db-{slug_}.html"
    if path.exists() and time.time() - path.stat().st_mtime < max_age:
        return path.read_text("utf-8", "replace")
    r = await gateway.request("GET", POE2DB + slug_, policy="poe2db")
    r.raise_for_status()
    gamedata.CACHE.mkdir(parents=True, exist_ok=True)
    path.write_bytes(r.content)
    return r.content.decode("utf-8", "replace")


async def refresh(force: bool = False) -> dict:
    """Fetch the sources and rebuild the tables. Runs on shazam before the seed is published; a
    failure keeps the last good tables and reports in `state`."""
    max_age = 0 if force else 86400
    try:
        raw = {f: await gamedata._get(REPOE + f, f"repoe-{f}", max_age) for f in REPOE_FILES}
        export = Export(**{k: json.loads(raw[f]) for k, f in zip(("mods", "bases", "classes", "augments"), REPOE_FILES)})
        stackable = await _page("Stackable_Currency", max_age)
        grants = [grant_from(name, await _page(s, max_age)) for s, name in grant_slugs(stackable)]
        derived = derive(export)
        import hashlib
        source = {f: hashlib.sha256(raw[f]).hexdigest()[:16] for f in REPOE_FILES}
        result = assemble(derived, export=export, currencies=currencies_from(stackable), grants=grants, source=source)
        store(result)
        log.info("mod pools rebuilt: %d pools, %d families, %d currencies, %d grant pages", len(result["pools"]), len(derived.families), len(result["currencies"]), len([g for g in grants if g]))
    except Exception as exc:
        state["last_error"] = str(exc)
        log.warning("mod pool refresh failed: %s", exc)
    return state


if __name__ == "__main__":   # the cron entry inside the backend container: python -m app.modpool [--force]
    logging.basicConfig(level=logging.INFO)
    import sys
    asyncio.run(refresh(force="--force" in sys.argv))
    raise SystemExit(1 if state.get("last_error") else 0)
