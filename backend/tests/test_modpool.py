"""The mod-pool tables (docs/mods-page-design.md → "Moving the tables into the market pipeline").

`app.modpool` turns the RePoE PoE2 export plus poe2db's currency pages into per-item-type pools
that ride the market seed. Everything is derived from the data: which item classes have a pool
and in which mod domain, which currencies open extra pools (the socketables say "Can roll X
modifiers"; the bones and the Genesis Tree key on tags no base carries), which orbs carry a
minimum modifier level, which essences and alloys force which mod. A new patch's data lands in
the tables with no code change.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_modpool.py -q
"""
import gzip
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import datapolicy, db, modpool  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures" / "mods"


def _gz(name):
    with gzip.open(FIX / name, "rt", encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture(scope="module")
def export():
    return modpool.Export(mods=_gz("mods.json.gz"), bases=_gz("base_items.json.gz"),
                          classes=_gz("item_classes.json.gz"), augments=_gz("augments.min.json.gz"))


@pytest.fixture(scope="module")
def derived(export):
    return modpool.derive(export)


# ------------------------------------------------------------------ text rules
def test_strip_markup_takes_the_printed_side():
    assert modpool.strip_markup("+(5-8) to [Strength|Strength]") == "+(5-8) to Strength"
    assert modpool.strip_markup("Adds (3-4) to (5-8) [Cold] damage to [Attack|Attacks]") == "Adds (3-4) to (5-8) Cold damage to Attacks"
    assert modpool.strip_markup("plain") == "plain"


def test_family_text_replaces_every_number_and_range_with_hash():
    assert modpool.family_text("+(10-19) to maximum Life") == "+# to maximum Life"
    assert modpool.family_text("Adds 1 to (2-3) Cold damage to Attacks") == "Adds # to # Cold damage to Attacks"
    assert modpool.family_text("(0.5-0.8)% of Damage Leeched as Life") == "#% of Damage Leeched as Life"
    assert modpool.family_text("-(15-12)% to Fire Resistance") == "-#% to Fire Resistance"
    assert modpool.family_text("Regenerate (1-2) Life per second\n+(3-4) to maximum Life") == "Regenerate # Life per second\n+# to maximum Life"


def test_tier_text_prints_ranges_with_an_en_dash():
    assert modpool.tier_text("+(10-19) to maximum Life") == "+(10–19) to maximum Life"
    assert modpool.tier_text("Adds 1 to (2-3) Cold") == "Adds 1 to (2–3) Cold"


# ------------------------------------------------------------------ pools
def test_pools_one_per_spawn_tag_set_per_class_named_as_poe2db_does(derived):
    by_class = {}
    for p in derived.pools:
        by_class.setdefault(p["class"], []).append(p)
    assert len(by_class["Rings"]) == 1 and by_class["Rings"][0]["id"] == "ring"
    assert len(by_class["Amulets"]) == 1
    gloves = sorted(p["name"] for p in by_class["Gloves"])
    for v in ["Str", "Dex", "Int", "Str/Dex", "Str/Int", "Dex/Int", "Str/Dex/Int"]:
        assert f"Gloves · {v}" in gloves
    assert "Gloves" not in gloves, "the attribute-less golden base is not a pool"
    wands = {p["name"]: p for p in by_class["Wands"]}
    assert "Wands" in wands and "Siphoning Wand" in wands["Wands"]["keywords"], "the plain variant keeps the class name"
    assert any(n.startswith("Wands · ") and "Bone Wand" in p["keywords"] for n, p in wands.items())
    assert sorted(p["name"] for p in by_class["Jewels"]) == [
        "Jewels · Diamond", "Jewels · Emerald", "Jewels · Ruby", "Jewels · Sapphire",
        "Jewels · Time-Lost Diamond", "Jewels · Time-Lost Emerald", "Jewels · Time-Lost Ruby", "Jewels · Time-Lost Sapphire"]
    assert {p["name"] for p in by_class["Waystones"]} == {"Waystones · T1–5", "Waystones · T6–10", "Waystones · T11–15", "Waystones · T16"}
    assert len(by_class["Tablet"]) == 8 and any(p["name"] == "Tablet · Breach" for p in by_class["Tablet"])
    assert sorted(p["name"] for p in by_class["Relics"]) == ["Relics · Amphora, Tapestry", "Relics · Coffer, Incense, Vase", "Relics · Seal, Urn"]
    assert len(by_class["Life Flasks"]) == 1
    assert all(" Staff" not in p["name"] for p in by_class.get("Staves", [])), "a lone base drops the class word: Staves · Reaping"
    assert "Sanctified Relics" not in by_class, "no mod keys on a sanctified relic"
    assert "Fishing Rods" not in by_class, "a class nothing rolls on is not a pool: no allowlist"
    ids = [p["id"] for p in derived.pools]
    assert len(set(ids)) == len(ids)
    for p in derived.pools:
        assert p["id"] and p["name"] and p["class"] and p["domain"] and p["tags"] and p["keywords"], p


def test_pool_domains_are_derived_from_where_the_bases_tags_reach(derived):
    domains = {p["class"]: p["domain"] for p in derived.pools}
    assert domains["Rings"] == "item" and domains["Wands"] == "item"
    assert domains["Jewels"] == "misc"
    assert domains["Life Flasks"] == "flask"
    assert domains["Relics"] == "sanctum_relic"
    assert domains["Waystones"] == "area"
    assert domains["Tablet"] == "tablet"
    assert domains["Expedition Logbooks"] == "expedition_relic"
    logbook = next(p for p in derived.pools if p["class"] == "Expedition Logbooks")
    assert "expedition_atoll_remnant_logbook" in logbook["tags"], "a logbook rolls its areas' mods: its tags are its domain's"


# ------------------------------------------------------------------ families
def test_families_cover_every_pool_domain_the_corruption_upgrades_and_the_keyed_desecrations(derived):
    fam = derived.families
    affixes = {f["affix"] for f in fam}
    assert affixes == {"prefix", "suffix", "corrupted", "enchant"}
    assert any(f["domain"] == d for d in ["misc", "flask", "area", "tablet", "sanctum_relic", "expedition_relic"] for f in fam)
    enchant = [f for f in fam if f["affix"] == "enchant"]
    assert enchant and all(t["id"].startswith("CorruptionUpgrade") for f in enchant for t in f["tiers"])
    assert not any("upgraded_corruption_mod" in f["tags"] for f in fam), "a bookkeeping tag is never a chip"
    ids = [f["id"] for f in fam]
    assert len(set(ids)) == len(ids)
    for f in fam:
        assert "[" not in f["text"] and "|" not in f["text"], f["text"]
        assert f["tiers"] and all(t["text"] and isinstance(t["ilvl"], int) and t["weights"] for t in f["tiers"]), f["id"]
        levels = [t["ilvl"] for t in f["tiers"]]
        assert levels == sorted(levels, reverse=True), f["id"]
    assert not any(t["id"] in ("BeltFlaskLifeRecoveryRateEssence1", "HandWrapsStrength1") for f in fam for t in f["tiers"]), "zero-weight mods never roll"


def test_the_ring_life_family_matches_poe2db(derived):
    ring = next(p for p in derived.pools if p["id"] == "ring")
    built = modpool.build_pool(ring, derived.families, derived.sections)
    base = built["sections"][0]
    life = next(f for f in base["prefix"] if f["text"] == "+# to maximum Life")
    assert [(t["tier"], t["name"], t["ilvl"]) for t in life["tiers"]] == [
        (1, "Virile", 54), (2, "Rotund", 46), (3, "Robust", 38), (4, "Stout", 33), (5, "Stalwart", 24), (6, "Sanguine", 16), (7, "Healthy", 6), (8, "Hale", 1)]
    assert life["tiers"][0]["text"] == "+(100–119) to maximum Life"
    assert "weights" not in life["tiers"][0], "the client never sees spawn weights"
    assert life["tags"] == ["life"]
    assert next(f for f in base["prefix"] if f["text"] == "+# to maximum Mana")["tiers"].__len__() == 12


# ------------------------------------------------------------------ sections (derived)
def test_sections_are_derived_from_the_data_not_listed(derived):
    secs = {s["id"]: s for s in derived.sections}
    assert derived.sections[0]["id"] == "base"
    # The socketables say which pool they open: "Can roll Destruction modifiers" → tag destruction.
    assert secs["destruction"]["title"] == "Thrud's Might"
    assert secs["destruction"]["keys"] == ["destruction"]
    assert "Wands" in secs["destruction"]["classes"] and "Bows" in secs["destruction"]["classes"] and "Gloves" not in secs["destruction"]["classes"]
    assert secs["marksman"]["title"] == "Kolr's Hunt" and secs["marksman"]["classes"] == ["Gloves"]
    # The bones and the Genesis Tree key on tags no base carries; their mods carry the base tags.
    # The bones' lords (unveiled at the Well of Souls) are ONE section, the lords as tags in it
    # (poe2db: one "Desecrated Modifiers" group; owner 2026-09-25). The Altered Collarbone's
    # otherworldly mods share the domain but are never unveiled: their own section (poe2db:
    # "Otherworldly"; owner 2026-09-28). Item-domain keys stay their own section.
    assert secs["desecrated"]["keys"] == ["amanamu_mod", "kurgal_mod", "ulaman_mod"]
    assert secs["desecrated"]["title"] == "Desecrated" and secs["desecrated"]["classes"] is None
    assert secs["breach_desecration"]["keys"] == ["breach_desecration"] and secs["breach_desecration"]["domain"] == "desecrated"
    assert secs["breach_desecration"]["title"] == "Breach Desecration" and not secs["breach_desecration"]["floored"]
    assert secs["breach_desecration"]["classes"] == ["Amulets", "Belts", "Rings"], "the Altered Collarbone's targets, from the tags its mods name"
    assert not any(k in secs for k in ["ulaman_mod", "amanamu_mod", "kurgal_mod"])
    # No currency names the Genesis Tree's pools; its mods scope them (each zero-weights the other
    # class): Rings and Belts, as poe2db lists them (not Amulets, weapons or armour).
    for k in ["genesis_tree_caster", "genesis_tree_minion"]:
        assert k in secs and secs[k]["classes"] == ["Belts", "Rings"] and secs[k]["keys"] == [k], k
    assert secs["genesis_tree_caster"]["title"] == "Genesis Tree Caster"
    # A key with no base tag and no carrier (Kulemak, Watcher) would show on every item: not a section.
    assert "kulemak_abyss_prefix" not in secs and "watcher_abyss_suffix" not in secs
    assert secs["corrupted"]["affixes"] == ["corrupted"] and secs["enchant"]["affixes"] == ["enchant"]
    # The orb's minimum modifier level applies where regular orbs roll: item-domain prefix/suffix pools.
    assert secs["base"]["floored"] and secs["destruction"]["floored"]
    assert not secs["desecrated"]["floored"] and not secs["corrupted"]["floored"] and not secs["enchant"]["floored"]


def test_build_pool_gives_each_item_type_only_the_sections_with_something_in_them(derived):
    pools = {p["id"]: p for p in derived.pools}
    ring = modpool.build_pool(pools["ring"], derived.families, derived.sections)
    ids = [s["id"] for s in ring["sections"]]
    assert ids[0] == "base" and "desecrated" in ids and "corrupted" in ids and "enchant" in ids and "destruction" not in ids
    assert "kurgal_mod" not in ids and "breach_desecration" in ids
    breach = next(s for s in ring["sections"] if s["id"] == "breach_desecration")
    assert len(breach["prefix"] + breach["suffix"]) == 16, "poe2db Rings: Otherworldly /16"
    assert not any("breach_desecration" in f["tags"] for f in breach["prefix"] + breach["suffix"]), "the key titles the section"
    assert not any(set(f["tags"]) & {"amanamu_mod", "kurgal_mod", "ulaman_mod"} for f in breach["prefix"] + breach["suffix"]), \
        "a lord's tag never rides into the otherworldly pool on a family that also holds a lord's tier"
    # In the merged section each family says which lord (key) rolls it, and the lords are chips.
    des = next(s for s in ring["sections"] if s["id"] == "desecrated")
    # One family can hold a lord's tier and an otherworldly tier (same group and text): each section
    # shows only its own currency's tiers.
    tiers_of = lambda sec: {(f["id"], t["name"], t["ilvl"]) for f in sec["prefix"] + sec["suffix"] for t in f["tiers"]}
    assert not (tiers_of(des) & tiers_of(breach)), "no tier is in both pools"
    exp = next(f for f in breach["suffix"] if f["id"] == "suffix:ExposureEffect@desecrated")
    assert [t["name"] for t in exp["tiers"]] and not any("Kurgal" in t["name"] for t in exp["tiers"])
    keyed = [f for f in des["prefix"] + des["suffix"] if set(f["tags"]) & {"amanamu_mod", "kurgal_mod", "ulaman_mod"}]
    assert keyed and len(keyed) == len(des["prefix"] + des["suffix"]), "every desecrated family carries its key"
    assert all(len(f["tags"]) == len(set(f["tags"])) for f in keyed), "a bone the mod already carries is not added twice"
    chips = {t["id"]: t for t in ring["tags"]}
    assert chips["amanamu_mod"]["label"] == "Amanamu"
    assert all(set(f["tags"][:1]) & {"amanamu_mod", "kurgal_mod", "ulaman_mod"} for f in keyed), \
        "the bone leads the row's tags: the two the row shows include it"
    order = [t["id"] for t in ring["tags"]]
    assert order.index("life") < order.index("amanamu_mod"), "the base pool's tags lead the row; the bones follow"
    assert order[0] == "elemental" and order.index("attack") < order.index("evasion"), "within a group the commoner tag first"
    assert "genesis_tree_caster" not in chips, "a single-key section is titled by its key; no chip repeats it"
    amulet = modpool.build_pool(pools["amulet"], derived.families, derived.sections)
    assert not {"genesis_tree_caster", "genesis_tree_minion"} & {s["id"] for s in amulet["sections"]}, "poe2db Amulets: no Genesis Tree"
    wand = modpool.build_pool(pools["wand"], derived.families, derived.sections)
    wids = [s["id"] for s in wand["sections"]]
    assert "destruction" in wids and "marksman" not in wids
    assert all(k in ring["sections"][0] for k in ("prefix", "suffix")) and "prefix" not in next(s for s in ring["sections"] if s["id"] == "corrupted")
    assert ring["tags"] and all(set(t) == {"id", "label"} for t in ring["tags"]), "a chip is an id and a label; counts stay here"
    assert not any(t["id"] in ("resource", "drop", "elemental_damage") for t in ring["tags"]), "compound and bookkeeping tags are not chips"
    # A Preserved Cranium desecrates a jewel, a Preserved Vertebrae a waystone: their mods key on the
    # base's own tags, no lord, and land in the Desecrated section (poe2db Ruby: Desecrated /32).
    jewel = modpool.build_pool(pools["jewel_ruby"], derived.families, derived.sections)
    assert [s["id"] for s in jewel["sections"]] == ["base", "desecrated"]
    assert jewel["sections"][0]["prefix"] or jewel["sections"][0]["suffix"]
    jdes = jewel["sections"][1]
    assert len(jdes["prefix"] + jdes["suffix"]) == 32
    assert not any(set(f["tags"]) & {"amanamu_mod", "kurgal_mod", "ulaman_mod"} for f in jdes["prefix"] + jdes["suffix"])
    lost = modpool.build_pool(pools["jewel_time_lost_ruby"], derived.families, derived.sections)
    assert len(next(s for s in lost["sections"] if s["id"] == "desecrated")["prefix"] + next(s for s in lost["sections"] if s["id"] == "desecrated")["suffix"]) == 12, "radius jewel mods"
    way = modpool.build_pool(pools["map_t16"], derived.families, derived.sections)
    wdes = next(s for s in way["sections"] if s["id"] == "desecrated")
    assert len(wdes["prefix"] + wdes["suffix"]) == 17
    assert "breach_desecration" not in [s["id"] for s in jewel["sections"] + way["sections"]]


def test_build_pool_never_repeats_a_section_title_as_a_tag_and_needs_no_base_section(derived):
    """A key that titles its section is not a tag in it, whether or not the export already marks the
    mod with it; and the chip row is built from whatever sections there are, not from the first."""
    pools = {p["id"]: p for p in derived.pools}
    caster = next(s for s in derived.sections if s["id"] == "genesis_tree_caster")
    whole = modpool.build_pool(pools["ring"], derived.families, derived.sections)
    shown = next(s for s in whole["sections"] if s["id"] == "genesis_tree_caster")
    fam = next(f for f in derived.families if f["id"] == (shown["prefix"] + shown["suffix"])[0]["id"])
    marked = [{**f, "tags": ["genesis_tree_caster"] + list(f["tags"])} if f is fam else f for f in derived.families]
    built = modpool.build_pool(pools["ring"], marked, [caster])
    assert [s["id"] for s in built["sections"]] == ["genesis_tree_caster"]
    rows = built["sections"][0]["prefix"] + built["sections"][0]["suffix"]
    row = next(r for r in rows if r["id"] == fam["id"])
    assert row["tags"] == list(fam["tags"]), "the section's own key is its title, never its tag"
    assert built["tags"] and "genesis_tree_caster" not in {t["id"] for t in built["tags"]}


# ------------------------------------------------------------------ poe2db pages
def test_currencies_from_the_stackable_list_every_item_with_a_level_rule():
    rows = modpool.currencies_from((FIX / "stackable.html").read_text())
    by = {r["name"]: r for r in rows}
    assert by["Greater Exalted Orb"] == {"id": "greater-exalted-orb", "name": "Greater Exalted Orb", "floor": 35, "cap": None}
    assert by["Perfect Orb of Augmentation"]["floor"] == 70
    assert by["Gnawed Jawbone"] == {"id": "gnawed-jawbone", "name": "Gnawed Jawbone", "floor": 0, "cap": 64}
    assert by["Ancient Rib"]["floor"] == 40
    assert "Exalted Orb" not in by and "Essence of the Body" not in by, "no level rule, no row"


def test_grant_pages_are_found_from_the_list_and_parsed_from_their_table():
    slugs = modpool.grant_slugs((FIX / "stackable.html").read_text())
    assert ("Essence_of_the_Body", "Essence of the Body") in slugs and ("Runic_Alloy", "Runic Alloy") in slugs
    assert not any(s[1] == "Greater Exalted Orb" for s in slugs)
    ess = modpool.grant_from("Greater Essence of the Body", (FIX / "essence-greater-body.html").read_text())
    assert ess["kind"] == "essence" and ess["tier"] == 2
    assert {"class": "Body Armours", "text": "+(100–119) to maximum Life", "affix": "prefix", "level": 43} in ess["rows"]
    assert {"class": "Amulets", "text": "+(85–99) to maximum Life", "affix": "prefix", "level": 36} in ess["rows"]
    alloy = modpool.grant_from("Runic Alloy", (FIX / "alloy-runic.html").read_text())
    assert alloy["kind"] == "alloy" and alloy["tier"] == 1
    assert {"class": "Rings", "text": "+(37–49) to maximum Runic Ward", "affix": "prefix", "level": 10} in alloy["rows"]
    assert modpool.grant_from("Exalted Orb", "<html><body>no table</body></html>") is None


def test_socketable_targets_resolve_to_class_names(export):
    plural = modpool.plural_index(export.classes)
    assert modpool.classes_of(["Helmets"], plural, export) == ["Helmets"]
    assert modpool.classes_of("Wand or Staff", plural, export) == ["Wands", "Staves"]
    assert modpool.classes_of("Quarterstaff or Spear", plural, export) == ["Quarterstaves", "Spears"]
    assert modpool.singulars("Foci") == ["Focus"] and "Staff" in modpool.singulars("Staves")
    assert "Bows" in modpool.classes_of("[MartialWeapon|Martial Weapon]", plural, export)
    assert "Wands" not in modpool.classes_of("[MartialWeapon|Martial Weapon]", plural, export)
    assert "Wands" in modpool.classes_of("[CasterWeapon|Caster Weapon]", plural, export)
    assert "Body Armours" in modpool.classes_of("Armour", plural, export)
    assert modpool.classes_of("Nonsense here", plural, export) == [], "an unknown phrase is dropped, never a crash"


# ------------------------------------------------------------------ storage and reads
def test_store_then_read_back_through_the_query_layer(export, derived):
    pages = {"Greater Essence of the Body": (FIX / "essence-greater-body.html").read_text(), "Runic Alloy": (FIX / "alloy-runic.html").read_text()}
    result = modpool.assemble(derived, export=export, currencies=modpool.currencies_from((FIX / "stackable.html").read_text()),
                              grants=[modpool.grant_from(n, h) for n, h in pages.items()], source={"repoe": "abc", "patch": "0.3.x"})
    modpool.store(result)
    pools = modpool.pools()
    assert any(p["id"] == "ring" for p in pools) and all("sections" not in p for p in pools)
    ring = modpool.pool("ring")
    assert ring["sections"][0]["id"] == "base" and ring["tags"]
    assert any(g["name"] == "Runic Alloy" for g in ring["grants"]["alloys"])
    assert not any(g["name"] == "Greater Essence of the Body" for g in ring["grants"]["essences"]), "the Body essence names no ring"
    amulet = modpool.pool("amulet")
    assert any(g["name"] == "Greater Essence of the Body" for g in amulet["grants"]["essences"])
    assert all(r["class"] == "Amulets" for g in amulet["grants"]["essences"] for r in g["rows"])
    assert any(a["name"] == "Adept Rune" for a in modpool.pool("wand")["grants"]["augments"])
    assert modpool.pool("nope") is None
    cur = modpool.currencies()
    assert any(c["name"] == "Greater Exalted Orb" and c["floor"] == 35 for c in cur)
    assert db.kv_get("mods_meta")["source"]["patch"] == "0.3.x"


def test_stored_grants_read_the_last_good_currencies_and_pages_back(export, derived):
    pages = {"Greater Essence of the Body": (FIX / "essence-greater-body.html").read_text(), "Runic Alloy": (FIX / "alloy-runic.html").read_text()}
    result = modpool.assemble(derived, export=export, currencies=modpool.currencies_from((FIX / "stackable.html").read_text()),
                              grants=[modpool.grant_from(n, h) for n, h in pages.items()], source={})
    modpool.store(result)
    cur, grants = modpool.stored_grants()
    assert any(c["name"] == "Greater Exalted Orb" for c in cur)
    names = {g["name"]: g for g in grants}
    assert set(names) == {"Greater Essence of the Body", "Runic Alloy"}
    body = names["Greater Essence of the Body"]
    assert body["kind"] == "essence" and body["tier"] == 2
    assert {"class": "Body Armours", "text": "+(100–119) to maximum Life", "affix": "prefix", "level": 43} in body["rows"]
    assert {"class": "Amulets", "text": "+(85–99) to maximum Life", "affix": "prefix", "level": 36} in body["rows"]
    # A rebuild with those carried-over grants gives the same pools back.
    again = modpool.assemble(derived, export=export, currencies=cur, grants=grants, source={})
    assert {p["id"]: p["data"]["grants"] for p in again["pools"]} == {p["id"]: p["data"]["grants"] for p in result["pools"]}


def test_the_tables_ride_the_seed():
    for t in ("mod_pools", "mod_currencies"):
        assert t in datapolicy.SEED_TABLES
        assert f"CREATE TABLE IF NOT EXISTS {t}" in db.MARKET_SCHEMA


def _priced_graph(values, edges):
    """A real Graph: the given digest edges (a, b, rate b per a, units of a per hour) and value table."""
    from app.arbitrage import Edge, Graph
    g = Graph({"reference": "exalted", "league": "L", "gold_value_per_1k": 0.0, "max_steps": 3, "filters": {}})
    for a, b, rate, vol in edges:
        g.add(Edge(a, b, "digest", rate, [{"rate": rate, "stock": 1_000_000}], age_s=0.0, vol_in_per_h=vol,
                   meta={"inactive": False, "quoted_rate": rate}))
    g.values = lambda: dict(values)
    return g


@pytest.fixture
def ring_grants(export, derived, monkeypatch):
    from app.currencies import registry
    pages = {"Runic Alloy": (FIX / "alloy-runic.html").read_text()}
    modpool.store(modpool.assemble(derived, export=export, currencies=[], grants=[modpool.grant_from(n, h) for n, h in pages.items()], source={}))
    monkeypatch.setattr(registry, "by_id", dict(registry.by_id))                  # the links below die with the test
    monkeypatch.setattr(registry, "meta_to_trade", dict(registry.meta_to_trade))
    registry._link("Metadata/Items/Currency/RunicAlloyTest", "runic-alloy")
    registry._link("Metadata/Items/Currency/AdeptRuneTest", "adept-rune")


def test_a_cost_is_shown_in_the_market_that_trades_the_grant_at_that_markets_rate(ring_grants, monkeypatch):
    """The volume rule (CLAUDE.md): a grant's cost is shown in its highest-volume counterpart it is
    (owner 2026-10-08: the busiest market, the view shows the readable side), at THAT market's rate — never its reference value divided by the
    counterpart's. The reference value rides along only for the display's approximation."""
    from app import arbitrage
    values = {"exalted": 1.0, "divine": 500.0, "runic-alloy": 49.11, "adept-rune": 1005.0}
    g = _priced_graph(values, [
        ("divine", "exalted", 500.0, 1_000), ("exalted", "divine", 1 / 500.0, 500_000),
        ("runic-alloy", "divine", 0.1, 40), ("runic-alloy", "exalted", 48.0, 10),   # divine busiest: 0.1 of one (the view draws "10 per Divine")
        ("adept-rune", "divine", 2.1, 30), ("adept-rune", "exalted", 990.0, 1),     # the rune's market is divine
    ])
    monkeypatch.setattr(arbitrage, "cached_graph", lambda *a, **k: g)
    out = modpool.prices("ring")
    assert out["reference"] == "exalted"
    assert out["prices"] == {
        "Runic Alloy": {"price": 0.1, "cur": "divine", "value_ref": 49.11},
        "Adept Rune": {"price": 2.1, "cur": "divine", "value_ref": 1005.0},
    }
    assert modpool.prices("wand")["prices"] == {"Adept Rune": {"price": 2.1, "cur": "divine", "value_ref": 1005.0}}, "a pool prices its own grants only"
    assert modpool.prices("nope") is None
    from fastapi.testclient import TestClient
    from app import main
    r = TestClient(main.app).get("/api/mods/pool/wand/prices")
    assert r.status_code == 200 and r.json()["prices"]["Adept Rune"]["cur"] == "divine"
    assert TestClient(main.app).get("/api/mods/pool/nope/prices").status_code == 404


def test_a_cost_with_no_market_in_its_currency_stays_in_the_reference_at_its_value(ring_grants, monkeypatch):
    """Worth past a divine but no divine market: showing it in divine would be a conversion through
    ex. It stays in the reference, at the value table's number. A grant nothing prices is absent."""
    from app import arbitrage
    g = _priced_graph({"exalted": 1.0, "divine": 500.0, "adept-rune": 1005.0},
                      [("divine", "exalted", 500.0, 1_000), ("exalted", "divine", 1 / 500.0, 500_000)])
    monkeypatch.setattr(arbitrage, "cached_graph", lambda *a, **k: g)
    assert modpool.prices("ring")["prices"] == {"Adept Rune": {"price": 1005.0, "cur": "exalted", "value_ref": 1005.0}}


def test_derive_builds_the_families_and_the_pools_once(export, monkeypatch):
    """families_from and pools_from each scan every mod against every class; derive() computes
    each once and hands them on (it ran families_from three times and pools_from twice)."""
    calls = {"families_from": 0, "pools_from": 0}
    for name in calls:
        real = getattr(modpool, name)
        def counted(*a, _real=real, _name=name, **k):
            calls[_name] += 1
            return _real(*a, **k)
        monkeypatch.setattr(modpool, name, counted)
    modpool.derive(export)
    assert calls == {"families_from": 1, "pools_from": 1}, calls


def test_a_desktop_install_never_rebuilds_its_mod_tables(monkeypatch, tmp_path):
    """Desktop installs read the mod tables their seed carries; only shazam builds them
    (`python -m app.modpool --force` in the publisher). A backend with a seed bundled is a desktop
    install, so POST /api/mods/refresh refuses there and never scrapes or overwrites the tables."""
    from fastapi.testclient import TestClient
    from app import db, main
    ran = []

    async def fake_refresh(force=False):
        ran.append(force)
        return {"pools": 1}
    monkeypatch.setattr(modpool, "refresh", fake_refresh)
    seed = tmp_path / "market-seed.sqlite.gz"
    seed.write_bytes(b"x")
    monkeypatch.setattr(db, "MARKET_SEED_PATH", seed)
    r = TestClient(main.app).post("/api/mods/refresh")
    assert r.status_code == 403 and ran == []
    monkeypatch.setattr(db, "MARKET_SEED_PATH", None)      # the server, or a dev backend with no seed
    r = TestClient(main.app).post("/api/mods/refresh")
    assert r.status_code == 200 and ran == [True]
