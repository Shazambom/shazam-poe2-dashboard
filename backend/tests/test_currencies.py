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
import threading
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app.currencies import Currency, Registry


def _reg():
    """A fresh registry with the on-disk seed loaded but the kv-backed sources emptied, so a
    test controls seed/bridge/user explicitly."""
    r = Registry()
    r._seed_overrides = {}
    r._bridge = {}
    r._user_overrides = {}
    r._rebuild_links()
    return r


UP2RARE = (
    "Metadata/Items/Currency/CurrencyUpgradeToRare"  # Orb of Alchemy (normal→rare)
)
UPMAGIC = "Metadata/Items/Currency/CurrencyUpgradeMagicToRare"  # Regal Orb (magic→rare)
FRACTURE = "Metadata/Items/Currency/CurrencyFractureRare"  # Fracturing Orb


def test_bridge_overrides_a_wrong_seed():
    """The authoritative poe2scout bridge wins over a conflicting seed entry — this is the real
    bug it fixes: the seed mislabeled Alchemy's metadata as `regal`."""
    r = _reg()
    r._seed_overrides = {UP2RARE: "regal"}  # the historical (wrong) seed value
    r._bridge = {UP2RARE: "alch"}  # poe2scout says Orb of Alchemy
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
    assert r.resolve_meta(FRACTURE) is None  # no seed/bridge/heuristic → unmapped
    assert FRACTURE in r.unmapped_meta
    r._bridge = {
        FRACTURE: "fracturing-orb"
    }  # in prod this comes from kv via load_bridge()
    r._rebuild_links()  # rebuild clears the negative cache
    assert r.resolve_meta(FRACTURE) == "fracturing-orb"
    assert FRACTURE not in r.unmapped_meta


def test_unmapped_currency_reports_none_and_is_tracked():
    """Anything none of the sources cover is None and recorded in unmapped_meta (surfaced/logged,
    never silently attributed to the wrong currency)."""
    r = _reg()
    meta = "Metadata/Items/Currency/CurrencyVerisiumMetal1"  # not in poe2scout
    assert r.resolve_meta(meta) is None
    assert meta in r.unmapped_meta


def test_heuristic_is_last_resort_fallback():
    """When no explicit source maps an id, the icon-stem heuristic can still match — but explicit
    sources take precedence over it."""
    r = _reg()
    # A currency whose icon filename stem matches the metadata id's last segment.
    r.by_id["widget"] = Currency(
        id="widget", name="Widget", icon="https://x/gen/Widget.png"
    )
    r._stems_n = -1  # force stem index rebuild
    meta = "Metadata/Items/Currency/Widget"
    assert r.resolve_meta(meta) == "widget"  # heuristic match
    # but an explicit bridge entry overrides the heuristic
    r2 = _reg()
    r2.by_id["widget"] = Currency(
        id="widget", name="Widget", icon="https://x/gen/Widget.png"
    )
    r2._stems_n = -1
    r2._bridge = {meta: "explicit"}
    r2._rebuild_links()
    assert r2.resolve_meta(meta) == "explicit"


def test_stem_index_iteration_survives_concurrent_apply_static():
    r = _reg()
    in_items = threading.Event()
    release = threading.Event()
    writer_entered = threading.Event()
    writer_done = threading.Event()

    class BlockingItemsDict(dict):
        def items(self) -> Any:
            first = True
            for pair in super().items():
                yield pair
                if first:
                    first = False
                    in_items.set()
                    assert release.wait(5)

    r.by_id = BlockingItemsDict(
        {
            "alpha": Currency(id="alpha", name="Alpha", icon="https://x/gen/Alpha.png"),
            "beta": Currency(id="beta", name="Beta", icon="https://x/gen/Beta.png"),
        }
    )
    r._stems_n = -1

    reader_errors: list[BaseException] = []
    writer_errors: list[BaseException] = []

    def reader() -> None:
        try:
            r._stem_index()
        except BaseException as exc:
            reader_errors.append(exc)

    def writer() -> None:
        try:
            writer_entered.set()
            r._apply_static(
                {"result": [{"entries": [{"id": "gamma", "text": "Gamma"}]}]}
            )
        except BaseException as exc:
            writer_errors.append(exc)
        finally:
            writer_done.set()

    t_reader = threading.Thread(target=reader)
    t_writer = threading.Thread(target=writer)
    t_reader.start()
    try:
        assert in_items.wait(2)
        t_writer.start()
        assert writer_entered.wait(2)
        writer_done.wait(0.05)
    finally:
        release.set()
        t_reader.join(5)
        if t_writer.ident is not None:
            t_writer.join(5)

    assert reader_errors == []
    assert writer_errors == []
    assert "gamma" in r.by_id


def test_rebuild_links_prevents_stale_stem_guess_overwriting_bridge(monkeypatch):
    r = _reg()
    meta = "Metadata/Items/Currency/StemName"
    r.by_id["bridge-id"] = Currency(
        id="bridge-id", name="Bridge Orb", icon="https://x/gen/OtherIcon.png"
    )
    r.by_id["stem-id"] = Currency(
        id="stem-id", name="Stem Orb", icon="https://x/gen/StemName.png"
    )
    r._bridge = {meta: "bridge-id"}
    r._rebuild_links()

    after_clear = threading.Event()
    allow_rebuild_finish = threading.Event()
    rebuild_done = threading.Event()
    resolver_entered = threading.Event()
    guessed = threading.Event()

    class BlockingClearDict(dict):
        def clear(self) -> None:
            super().clear()
            after_clear.set()
            assert allow_rebuild_finish.wait(5)

    r.meta_to_trade = BlockingClearDict(r.meta_to_trade)

    orig_stem_index = r._stem_index

    def pause_after_guess() -> dict[str, str]:
        stems = orig_stem_index()
        guessed.set()
        assert rebuild_done.wait(5)
        return stems

    monkeypatch.setattr(r, "_stem_index", pause_after_guess)

    resolved: list[str | None] = []
    errors: list[BaseException] = []

    def rebuilder() -> None:
        try:
            r._rebuild_links()
        except BaseException as exc:
            errors.append(exc)
        finally:
            rebuild_done.set()

    def resolver() -> None:
        try:
            resolver_entered.set()
            resolved.append(r.resolve_meta(meta))
        except BaseException as exc:
            errors.append(exc)

    t_rebuild = threading.Thread(target=rebuilder)
    t_resolve = threading.Thread(target=resolver)
    t_rebuild.start()
    try:
        assert after_clear.wait(2)
        t_resolve.start()
        assert resolver_entered.wait(2)
        guessed.wait(0.05)
    finally:
        allow_rebuild_finish.set()
        t_rebuild.join(5)
        rebuild_done.set()
        if t_resolve.ident is not None:
            t_resolve.join(5)

    assert errors == []
    assert resolved == ["bridge-id"]
    assert r.meta_to_trade[meta] == "bridge-id"


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))


def test_external_iteration_of_by_id_survives_a_concurrent_static_apply():
    # graph, modpool, recipes, movers and leaguearc iterate registry.by_id from worker threads
    # without the registry lock; a rebuild must not change the dict they are iterating.
    reg = Registry()
    reg._apply_static(
        {
            "result": [
                {
                    "id": "Currency",
                    "entries": [{"id": "a", "text": "A"}, {"id": "b", "text": "B"}],
                }
            ]
        }
    )
    it = iter(reg.by_id.items())
    next(it)
    reg._apply_static(
        {"result": [{"id": "Currency", "entries": [{"id": "zz-new", "text": "New"}]}]}
    )
    reg._link("Metadata/Items/Currency/ZzOther", "zz-other")
    list(it)  # would raise RuntimeError: dictionary changed size during iteration
    assert "zz-new" in reg.by_id and "zz-other" in reg.by_id
