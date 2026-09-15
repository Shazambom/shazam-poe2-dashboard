"""Tests for the currency registry's metadata→trade mapping, especially the authoritative
poe2scout bridge and its precedence over the seed file and heuristic.

Root problem this guards: the hourly digest keys markets by GGG metadata ids
(`Metadata/Items/Currency/CurrencyFractureRare`); the app keys currencies by trade ids
(`fracturing-orb`). poe2scout returns both (`BaseItemTypeId` + `ApiId`), giving an exact
bridge. These tests pin the precedence (seed < bridge < user) and that semantically-distinct
currencies never collapse together.

    python -m pytest backend/tests/test_currencies.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app.currencies import Currency, Registry  # noqa: E402


def _reg():
    """A fresh registry with the on-disk seed loaded but the kv-backed sources emptied, so a
    test controls seed/bridge/user explicitly."""
    r = Registry()
    r._seed_overrides = {}
    r._bridge = {}
    r._user_overrides = {}
    r._rebuild_links()
    return r


UP2RARE = "Metadata/Items/Currency/CurrencyUpgradeToRare"        # Orb of Alchemy (normal→rare)
UPMAGIC = "Metadata/Items/Currency/CurrencyUpgradeMagicToRare"   # Regal Orb (magic→rare)
FRACTURE = "Metadata/Items/Currency/CurrencyFractureRare"        # Fracturing Orb


def test_bridge_overrides_a_wrong_seed():
    """The authoritative poe2scout bridge wins over a conflicting seed entry — this is the real
    bug it fixes: the seed mislabeled Alchemy's metadata as `regal`."""
    r = _reg()
    r._seed_overrides = {UP2RARE: "regal"}     # the historical (wrong) seed value
    r._bridge = {UP2RARE: "alch"}              # poe2scout says Orb of Alchemy
    r._rebuild_links()
    assert r.resolve_meta(UP2RARE) == "alch"


def test_user_override_beats_bridge():
    """An explicit human override is highest precedence."""
    r = _reg()
    r._bridge = {UP2RARE: "alch"}
    r._user_overrides = {UP2RARE: "hand-picked"}
    r._rebuild_links()
    assert r.resolve_meta(UP2RARE) == "hand-picked"


def test_seed_used_when_bridge_absent():
    """With no bridge entry (e.g. pre-first-crawl), the seed still maps."""
    r = _reg()
    r._seed_overrides = {FRACTURE: "fracturing-orb"}
    r._rebuild_links()
    assert r.resolve_meta(FRACTURE) == "fracturing-orb"


def test_semantically_distinct_currencies_stay_distinct():
    """Alchemy and Regal both 'upgrade to rare' but are different currencies — the bridge keeps
    their metadata ids mapped to different trade ids (never merged)."""
    r = _reg()
    r._bridge = {UP2RARE: "alch", UPMAGIC: "regal"}
    r._rebuild_links()
    assert r.resolve_meta(UP2RARE) == "alch"
    assert r.resolve_meta(UPMAGIC) == "regal"
    assert r.resolve_meta(UP2RARE) != r.resolve_meta(UPMAGIC)


def test_bridge_fixes_a_previously_unmapped_currency():
    """A currency the heuristic couldn't map (Fracturing Orb) resolves once the bridge provides
    it — including clearing the negative cache from a prior failed lookup."""
    r = _reg()
    assert r.resolve_meta(FRACTURE) is None       # no seed/bridge/heuristic → unmapped
    assert FRACTURE in r.unmapped_meta
    r._bridge = {FRACTURE: "fracturing-orb"}       # in prod this comes from kv via load_bridge()
    r._rebuild_links()                             # rebuild clears the negative cache
    assert r.resolve_meta(FRACTURE) == "fracturing-orb"
    assert FRACTURE not in r.unmapped_meta


def test_unmapped_currency_reports_none_and_is_tracked():
    """Anything none of the sources cover is None and recorded in unmapped_meta (surfaced/logged,
    never silently attributed to the wrong currency)."""
    r = _reg()
    meta = "Metadata/Items/Currency/CurrencyVerisiumMetal1"   # not in poe2scout
    assert r.resolve_meta(meta) is None
    assert meta in r.unmapped_meta


def test_heuristic_is_last_resort_fallback():
    """When no explicit source maps an id, the icon-stem heuristic can still match — but explicit
    sources take precedence over it."""
    r = _reg()
    # A currency whose icon filename stem matches the metadata id's last segment.
    r.by_id["widget"] = Currency(id="widget", name="Widget", icon="https://x/gen/Widget.png")
    r._stems_n = -1                               # force stem index rebuild
    meta = "Metadata/Items/Currency/Widget"
    assert r.resolve_meta(meta) == "widget"       # heuristic match
    # but an explicit bridge entry overrides the heuristic
    r2 = _reg()
    r2.by_id["widget"] = Currency(id="widget", name="Widget", icon="https://x/gen/Widget.png")
    r2._stems_n = -1
    r2._bridge = {meta: "explicit"}
    r2._rebuild_links()
    assert r2.resolve_meta(meta) == "explicit"


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
