"""The exchange's items the app could not name (bug report FY0M4R, 2026-10-02: "The item "Raven's
reflection" doesn't show up … under "What you hold""). The hourly digest keys markets by GGG metadata
id; the registry names an id only through poe2scout's bridge, the seed map, a user override or an
icon-filename guess, so 43 traded ids were unpickable and unpriced (Raven's Reflection the most
traded). The pipeline (on shazam, `modpool.refresh`) builds `meta_catalog` from the game's own item
table (repoe base_items) and the trade site's item list; it rides the seed, installs only read it.

The rule, measured on real data (all 30 art-path matches are also exact-name matches):
- the trade id is the trade-site entry with the item's EXACT name; the art path only breaks a tie
  between two entries of that name. Art alone never decides: Thaumaturgic Flux (Level 1) shares its
  art with levels 2-20 and is not on the trade site, so an art match would price it as another item;
- an item the trade site does not list gets an id made the trade site's way from its name
  ("ravens-reflection"), its game name, its exchange category, and its icon (poe2db's copy of the
  game art, fetched by the pipeline and carried as data, so installs contact no new host);
- an id that would collide with a different trade-site item is left out; ids the bridge maps are
  the bridge's (bridge and user overrides beat the catalog)."""
import base64
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import catalog, datapolicy, db  # noqa: E402
from app.currencies import Registry  # noqa: E402

RAVEN = "Metadata/Items/Currency/Delirium/DeliriumPinnacleKey"
BLOOM = "Metadata/Items/MapFragments/CurrencyWildwoodFragment"
FLUX1 = "Metadata/Items/Currency/CurrencySetKalguuranSkillGemLevel1"
FLUX5 = "Metadata/Items/Currency/CurrencySetKalguuranSkillGemLevel5"
HAWK = "Metadata/Items/SoulCores/IdolHawk"
CHAOS = "Metadata/Items/Currency/CurrencyRerollRare"


def gen_image(art):
    """A trade-site icon path, as the site writes them: /gen/image/<base64 JSON>/<hash>/<file>.png."""
    b = base64.urlsafe_b64encode(json.dumps([25, 14, {"f": art, "scale": 1, "realm": "poe2"}]).encode()).decode().rstrip("=")
    return f"/gen/image/{b}/abc123/{art.rsplit('/', 1)[-1]}.png"


def base(name, dds, cls="StackableCurrency"):
    return {"name": name, "item_class": cls, "visual_identity": {"dds_file": f"Art/{dds}.dds", "id": "x"}}


BASES = {
    RAVEN: base("Raven's Reflection", "2DItems/Maps/TangamazuKey", "MapFragment"),
    BLOOM: base("Sacred Bloom", "2DItems/Currency/Harvest/SacredLifeforce"),
    FLUX1: base("Thaumaturgic Flux (Level 1)", "2DItems/Currency/Flux"),
    FLUX5: base("Thaumaturgic Flux (Level 5)", "2DItems/Currency/Flux"),
    HAWK: base("Hawk Idol", "2DItems/Currency/TormentedSpiritSocketables/AzmeriSocketableHawk"),
    CHAOS: base("Chaos Orb", "2DItems/Currency/CurrencyRerollRare"),
}
STATIC = {"result": [
    {"id": "Currency", "label": "Currency", "entries": [
        {"id": "chaos", "text": "Chaos Orb", "image": gen_image("2DItems/Currency/CurrencyRerollRare")},
        {"id": "thaumaturgic-flux-2", "text": "Thaumaturgic Flux (Level 2)", "image": gen_image("2DItems/Currency/Flux")},
        {"id": "thaumaturgic-flux-5", "text": "Thaumaturgic Flux (Level 5)", "image": gen_image("2DItems/Currency/Flux")},
    ]},
    {"id": "Fragments", "label": "Fragments", "entries": [
        {"id": "sacred-bloom", "text": "Sacred Bloom", "image": gen_image("2DItems/Currency/Harvest/SacredLifeforce")},
        {"id": "sacred-bloom-old", "text": "Sacred Bloom", "image": gen_image("2DItems/Other/Elsewhere")},
        {"id": "hawk-idol", "text": "A Different Item"},          # the slug is taken by something else
    ]},
]}
CATEGORIES = {RAVEN: {"category": "Delirium"}, HAWK: {"category": "Idols"}}


def built(metas=(RAVEN, BLOOM, FLUX1, FLUX5, HAWK, CHAOS), bridged=()):
    return catalog.build(BASES, STATIC, metas, set(bridged), CATEGORIES)


def test_art_path_is_read_from_a_trade_site_icon():
    assert catalog.art_of(gen_image("2DItems/Currency/Flux")) == "2DItems/Currency/Flux"
    assert catalog.art_of("/image/x.png") is None and catalog.art_of(None) is None
    assert catalog.art_of("/gen/image/!!notbase64/abc/x.png") is None


def test_a_listed_item_maps_to_its_trade_id_by_exact_name_art_breaking_a_tie():
    c = built()
    assert c[BLOOM] == {"id": "sacred-bloom"}, "two entries named Sacred Bloom: the one with the item's art"
    assert c[FLUX5] == {"id": "thaumaturgic-flux-5"}


def test_shared_art_alone_never_names_an_item():
    assert c_id(FLUX1) == "thaumaturgic-flux-level-1", "levels 2-20 share its art; it is not on the trade site"


def c_id(meta):
    return built()[meta]["id"]


def test_an_unlisted_item_gets_its_own_id_name_category_and_art():
    assert built()[RAVEN] == {"id": "ravens-reflection", "name": "Raven's Reflection", "category": "Delirium",
                              "art": "Art/2DItems/Maps/TangamazuKey"}


def test_a_colliding_id_bridged_ids_and_unknown_ids_are_left_out():
    c = built(metas=(RAVEN, HAWK, CHAOS, "Metadata/Items/Not/InBaseItems"), bridged=(CHAOS,))
    assert HAWK not in c, "hawk-idol is a different trade-site item"
    assert CHAOS not in c and "Metadata/Items/Not/InBaseItems" not in c
    assert set(c) == {RAVEN}


def test_icon_url_is_poe2dbs_copy_of_the_game_art():
    assert catalog.icon_source("Art/2DItems/Maps/TangamazuKey") == "https://cdn.poe2db.tw/image/Art/2DItems/Maps/TangamazuKey.webp"


@pytest.fixture
def clean_kv():
    yield
    for k in ("meta_catalog", "meta_bridge", "meta_overrides", "trade_static_cache"):
        db.kv_set(k, {})


def test_refresh_stores_the_catalog_with_icons_as_data(monkeypatch, clean_kv):
    asked = []

    async def fetch(url, name, max_age):
        asked.append(url)
        if "Hawk" in url:
            raise OSError("down")
        return b"RIFF....WEBPVP8 "

    monkeypatch.setattr(catalog.gamedata, "_get", fetch)
    db.kv_set("trade_static_cache", STATIC)
    db.kv_set("meta_bridge", {CHAOS: "chaos"})
    import asyncio
    err = asyncio.run(catalog.refresh(BASES, metas=[RAVEN, BLOOM, CHAOS], categories=CATEGORIES, max_age=0))
    got = db.kv_get("meta_catalog")
    assert got[BLOOM] == {"id": "sacred-bloom"} and CHAOS not in got
    assert got[RAVEN]["icon"] == "data:image/webp;base64," + base64.b64encode(b"RIFF....WEBPVP8 ").decode()
    assert "art" not in got[RAVEN], "the art path was only the icon's address"
    assert err is None
    assert asked == ["https://cdn.poe2db.tw/image/Art/2DItems/Maps/TangamazuKey.webp"], "only unlisted items fetch an icon"


def test_refresh_without_the_trade_list_keeps_the_last_catalog(monkeypatch, clean_kv):
    db.kv_set("meta_catalog", {RAVEN: {"id": "ravens-reflection", "name": "Raven's Reflection"}})
    db.kv_set("trade_static_cache", {})
    import asyncio
    err = asyncio.run(catalog.refresh(BASES, metas=[RAVEN], categories={}, max_age=0))
    assert err and "trade list" in err
    assert db.kv_get("meta_catalog")[RAVEN]["id"] == "ravens-reflection"


def test_a_failed_icon_keeps_the_items_last_icon(monkeypatch, clean_kv):
    db.kv_set("meta_catalog", {RAVEN: {"id": "ravens-reflection", "name": "Raven's Reflection", "icon": "data:old"}})
    db.kv_set("trade_static_cache", STATIC)

    async def down(url, name, max_age):
        raise OSError("down")
    monkeypatch.setattr(catalog.gamedata, "_get", down)
    import asyncio
    asyncio.run(catalog.refresh(BASES, metas=[RAVEN], categories=CATEGORIES, max_age=0))
    assert db.kv_get("meta_catalog")[RAVEN]["icon"] == "data:old"


def test_the_registry_names_and_prices_catalog_items_bridge_and_user_still_win(clean_kv):
    db.kv_set("meta_catalog", {RAVEN: {"id": "ravens-reflection", "name": "Raven's Reflection", "category": "Delirium",
                                       "icon": "data:image/webp;base64,AAAA"},
                               BLOOM: {"id": "sacred-bloom"}, CHAOS: {"id": "not-chaos"}, HAWK: {"id": "user-wins"}})
    db.kv_set("meta_bridge", {CHAOS: "chaos"})
    db.kv_set("meta_overrides", {HAWK: "hawk-by-hand"})
    r = Registry()
    assert r.resolve_meta(RAVEN) == "ravens-reflection"
    cur = r.by_id["ravens-reflection"]
    assert (cur.name, cur.category, cur.icon) == ("Raven's Reflection", "Delirium", "data:image/webp;base64,AAAA")
    assert r.resolve_meta(BLOOM) == "sacred-bloom"
    assert r.resolve_meta(CHAOS) == "chaos", "the bridge beats the catalog"
    assert r.resolve_meta(HAWK) == "hawk-by-hand", "a user's mapping beats everything"
    assert "not-chaos" not in r.by_id and "user-wins" not in r.by_id, "an overridden catalog entry leaves nothing behind"
    assert any(c["id"] == "ravens-reflection" and c["name"] == "Raven's Reflection" for c in r.to_json()["currencies"])


def test_the_trade_list_does_not_rename_a_catalog_item_it_does_not_list(clean_kv):
    db.kv_set("meta_catalog", {RAVEN: {"id": "ravens-reflection", "name": "Raven's Reflection", "icon": "data:x"}})
    r = Registry()
    r._apply_static(STATIC)
    assert r.by_id["ravens-reflection"].name == "Raven's Reflection" and r.resolve_meta(RAVEN) == "ravens-reflection"


def test_the_catalog_is_market_data_that_rides_the_seed():
    assert not datapolicy.is_user_kv("meta_catalog") and "kv_ops" in datapolicy.SEED_TABLES


def test_the_pipeline_builds_it():
    src = (Path(__file__).resolve().parents[1] / "app" / "modpool.py").read_text()
    assert "await catalog.refresh(" in src
