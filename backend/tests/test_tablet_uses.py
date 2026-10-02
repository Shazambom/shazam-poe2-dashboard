"""A tablet's full uses, from poe2db through the market pipeline (owner, 2026-10-01: "we should be
using our data architecture to solve this, don't derive this").

The Strat Calculator spreads a tablet's price over the maps it lasts and prices only full, uncorrupted
tablets. Normal tablets have 10 uses whatever their rarity; unique tablets have their own (Freedom of
Faith 5, the Irradiated uniques 1). Read on shazam by modpool.refresh into kv_ops `tablet_uses`,
which rides the seed; installs only read it.

- Normal bases: the "Tablet Item" list on poe2db's Tablet page ("<n> uses remaining").
- Uniques: the sample item on each unique's page (its implicit "\\n<n> uses remaining"). NOT the
  page's popup or Stats row, which print the base's 10 for the 5-use uniques (research 2026-10-01).
  A unique without a sample item, or whose sample is corrupted, is unknown: never a guess.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_tablet_uses.py -q
"""
import asyncio
import gzip
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import modpool  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures" / "mods"


def page(slug: str) -> str:
    with gzip.open(FIX / f"poe2db-{slug}.html.gz", "rt", encoding="utf-8") as f:
        return f.read()


BASES = ["Abyss Tablet", "Breach Tablet", "Delirium Tablet", "Expedition Tablet", "Irradiated Tablet",
         "Overseer Tablet", "Ritual Tablet", "Temple Tablet"]


def test_the_tablet_page_gives_every_normal_base_at_ten_uses():
    assert sorted(modpool.tablet_bases_from(page("Tablet")), key=lambda r: r["base"]) == \
        [{"name": None, "base": b, "uses": 10} for b in BASES]


def test_the_tablet_page_lists_the_unique_pages_to_read():
    uniques = modpool.tablet_unique_pages(page("Tablet"))
    assert ("Freedom_of_Faith", "Freedom of Faith") in uniques
    assert ("Mastered_Domain", "Mastered Domain") in uniques
    assert len(uniques) == 9, "Forgotten By Time no longer drops, so poe2db's list leaves it out"
    assert all(" " not in s for s, _ in uniques)


def test_a_unique_reads_its_sample_item_not_the_popup():
    assert modpool.unique_tablet_uses_from(page("Freedom_of_Faith")) == {"name": "Freedom of Faith", "base": "Ritual Tablet", "uses": 5}
    assert modpool.unique_tablet_uses_from(page("Wraeclast_Besieged")) == {"name": "Wraeclast Besieged", "base": "Breach Tablet", "uses": 5}
    assert modpool.unique_tablet_uses_from(page("Mastered_Domain")) == {"name": "Mastered Domain", "base": "Irradiated Tablet", "uses": 1}


def test_a_unique_without_a_trustworthy_sample_is_unknown():
    assert modpool.unique_tablet_uses_from(page("Forgotten_By_Time")) is None, "no sample item: never the popup's 10"
    corrupted = page("Freedom_of_Faith").replace('"rarity": "Unique",', '"rarity": "Unique",\n    "corrupted": true,', 1)
    assert modpool.unique_tablet_uses_from(corrupted) is None, "a corrupted sample's uses are not the full uses"
    assert modpool.unique_tablet_uses_from("<html>poe2db changed</html>") is None


def test_a_changed_tablet_page_gives_nothing():
    assert modpool.tablet_bases_from("<html><body>no list</body></html>") == []
    assert modpool.tablet_unique_pages("<html><body>no list</body></html>") == []


# ------------------------------------------------------------------ refresh (shazam)
@pytest.fixture
def fake_pages(monkeypatch):
    served = {"Tablet": page("Tablet")}
    for s in ("Freedom_of_Faith", "Mastered_Domain", "Wraeclast_Besieged"):
        served[s] = page(s)

    async def fake_page(slug, max_age):
        if slug not in served:
            raise OSError(f"no fixture for {slug}")
        return served[slug]

    monkeypatch.setattr(modpool, "_page", fake_page)
    yield served
    from app import db
    db.kv_set("tablet_uses", [])


def test_refresh_stores_bases_and_the_uniques_it_could_read(fake_pages):
    from app import db
    err = asyncio.run(modpool.refresh_tablet_uses(0))
    stored = db.kv_get("tablet_uses")
    assert {"name": None, "base": "Breach Tablet", "uses": 10} in stored
    assert {"name": "Freedom of Faith", "base": "Ritual Tablet", "uses": 5} in stored
    assert {"name": "Mastered Domain", "base": "Irradiated Tablet", "uses": 1} in stored
    assert len(stored) == 8 + 3, "uniques whose page could not be read are left out, not guessed"
    assert err is None, "a missing unique page is not a failed run: the bases and the readable uniques stored"


def test_an_unreadable_tablet_page_keeps_the_last_good_list_and_fails_the_run(fake_pages):
    from app import db
    asyncio.run(modpool.refresh_tablet_uses(0))
    good = db.kv_get("tablet_uses")
    fake_pages["Tablet"] = "<html><body>poe2db changed</body></html>"
    err = asyncio.run(modpool.refresh_tablet_uses(0))
    assert db.kv_get("tablet_uses") == good
    assert "tablet" in (err or ""), "the cron sees it (exit 1), never a silent keep"


def test_refresh_runs_the_tablet_step():
    import inspect
    assert "refresh_tablet_uses(" in inspect.getsource(modpool.refresh)


def test_the_tablet_uses_ride_the_seed():
    from app import datapolicy
    assert not datapolicy.is_user_kv("tablet_uses")
    assert "kv_ops" in datapolicy.SEED_TABLES
