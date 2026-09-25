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
    for k in ["ulaman_mod", "amanamu_mod", "kurgal_mod", "breach_desecration", "genesis_tree_caster", "genesis_tree_minion"]:
        assert k in secs and secs[k]["classes"] is None, k
    assert secs["ulaman_mod"]["title"] == "Ulaman"
    assert secs["genesis_tree_caster"]["title"] == "Genesis Tree Caster"
    # A key with no base tag and no carrier (Kulemak, Watcher) would show on every item: not a section.
    assert "kulemak_abyss_prefix" not in secs and "watcher_abyss_suffix" not in secs
    assert secs["corrupted"]["affixes"] == ["corrupted"] and secs["enchant"]["affixes"] == ["enchant"]
    # The orb's minimum modifier level applies where regular orbs roll: item-domain prefix/suffix pools.
    assert secs["base"]["floored"] and secs["destruction"]["floored"]
    assert not secs["ulaman_mod"]["floored"] and not secs["corrupted"]["floored"] and not secs["enchant"]["floored"]


def test_build_pool_gives_each_item_type_only_the_sections_with_something_in_them(derived):
    pools = {p["id"]: p for p in derived.pools}
    ring = modpool.build_pool(pools["ring"], derived.families, derived.sections)
    ids = [s["id"] for s in ring["sections"]]
    assert ids[0] == "base" and "kurgal_mod" in ids and "corrupted" in ids and "enchant" in ids and "destruction" not in ids
    assert "breach_desecration" in ids or "genesis_tree_caster" in ids
    wand = modpool.build_pool(pools["wand"], derived.families, derived.sections)
    wids = [s["id"] for s in wand["sections"]]
    assert "destruction" in wids and "marksman" not in wids
    assert all(k in ring["sections"][0] for k in ("prefix", "suffix")) and "prefix" not in next(s for s in ring["sections"] if s["id"] == "corrupted")
    assert ring["tags"] and all({"id", "label", "count"} <= set(t) for t in ring["tags"])
    assert not any(t["id"] in ("resource", "drop", "elemental_damage") for t in ring["tags"]), "compound and bookkeeping tags are not chips"
    jewel = modpool.build_pool(pools["jewel_ruby"], derived.families, derived.sections)
    assert [s["id"] for s in jewel["sections"]] == ["base"], "a jewel has its base pool only"
    assert jewel["sections"][0]["prefix"] or jewel["sections"][0]["suffix"]


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
