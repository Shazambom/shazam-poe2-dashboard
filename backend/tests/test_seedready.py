"""The seed ships a league's days only when every tracked item's row for them is final
(docs/bugs/2026-09-28-partial-sync-data.md, fix plan step 1). The pure half: given what poe2scout's
category listing reports (each item's last few daily Price/Quantity = our average/volume) and what we
store, which day can the seed end on, and which items must be re-fetched to get further.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_seedready.py -q
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import seedready as sr  # noqa: E402

D1, D2, D3, D4, D5 = "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"


def _row(avg, vol):
    return (avg, vol)


def test_poe2scout_has_moved_past_a_day_once_most_items_report_the_next():
    listing = {1: {D1: _row(1, 1), D2: _row(1, 1), D3: _row(1, 1)}, 2: {D1: _row(1, 1), D2: _row(1, 1), D3: _row(1, 1)},
               3: {D2: _row(1, 1)}}                              # thin: skipped D1, nothing on D3
    assert sr.final_through(listing) == D2
    assert sr.final_through({}) is None


def test_most_traders_must_have_moved_on_not_just_a_few():
    """poe2scout part-way through posting a new day has not finished the one before."""
    listing = {i: {D2: _row(1, 1), D3: _row(1, 1)} for i in range(10)}
    for i in range(3):
        listing[i][D4] = _row(1, 1)
    assert sr.final_through(listing) == D2


def test_one_item_with_a_stray_newer_day_does_not_move_the_league():
    listing = {i: {D2: _row(1, 1), D3: _row(1, 1)} for i in range(1, 6)}
    listing[9] = {D4: _row(1, 1)}
    assert sr.final_through(listing) == D2


def test_every_item_matching_the_listing_ends_the_seed_on_the_last_final_day():
    listing = {1: {D2: _row(10.0, 5), D3: _row(11.0, 2)}, 2: {D2: _row(3.0, 7), D3: _row(3.1, 1)}}
    stored = {1: {D2: _row(10.0, 5), D3: _row(11.0, 2)}, 2: {D2: _row(3.0, 7), D3: _row(3.1, 1)}}
    a = sr.assess(listing, stored, fingerprints={})
    assert a.through == D2 and a.cut == D2 and a.stale == set()


def test_a_row_fetched_mid_day_is_not_final_and_cuts_the_seed_a_day_earlier():
    listing = {1: {D1: _row(9, 4), D2: _row(10.0, 50), D3: _row(1, 1)}, 2: {D1: _row(3, 7), D2: _row(3, 70), D3: _row(1, 1)}}
    stored = {1: {D1: _row(9, 4), D2: _row(10.0, 12)},              # fetched before D2 closed
              2: {D1: _row(3, 7), D2: _row(3, 70)}}
    a = sr.assess(listing, stored, fingerprints={})
    assert a.through == D2 and a.cut == D1 and a.stale == {1}


def test_a_float32_price_matches_our_stored_double():
    listing = {1: {D2: _row(554.2194, 22678475), D3: _row(1, 1)}}
    stored = {1: {D2: _row(554.2194313973129, 22678475)}}
    assert sr.assess(listing, stored, fingerprints={}).cut == D2


def test_a_thin_item_with_no_trade_on_a_day_is_final_when_we_hold_no_row_either():
    listing = {1: {D2: _row(1, 1), D3: _row(1, 1)}, 2: {D1: _row(5, 1)}}   # 2 traded D1 only
    stored = {1: {D2: _row(1, 1), D3: _row(1, 1)}, 2: {D1: _row(5, 1)}}
    a = sr.assess(listing, stored, fingerprints={})
    assert a.cut == D2 and a.stale == set()


def test_a_row_poe2scout_no_longer_reports_is_stale():
    listing = {1: {D2: _row(1, 1), D3: _row(1, 1)}, 2: {D1: _row(5, 1)}}
    stored = {1: {D2: _row(1, 1)}, 2: {D1: _row(5, 1), D2: _row(5, 3)}}
    a = sr.assess(listing, stored, fingerprints={})
    assert a.stale == {2} and a.cut < D2


def test_a_frozen_item_missing_the_window_is_stale():
    """An item that fell under the price floor stopped being crawled; poe2scout still lists it."""
    listing = {1: {D2: _row(1, 1), D3: _row(1, 1)}, 2: {D1: _row(2, 2), D2: _row(2, 2)}}
    stored = {1: {D2: _row(1, 1)}, 2: {}}
    assert sr.assess(listing, stored, fingerprints={}).stale == {2}


def test_a_revised_old_day_cuts_the_seed_below_it():
    listing = {1: {D1: _row(9, 99), D2: _row(1, 1), D3: _row(1, 1)}}
    stored = {1: {D1: _row(9, 4), D2: _row(1, 1)}}
    a = sr.assess(listing, stored, fingerprints={})
    assert a.stale == {1} and (a.cut is None or a.cut < D1)


def test_fetching_again_while_poe2scout_is_unchanged_is_never_needed():
    """An item we re-fetched after poe2scout moved past the day, whose listing has not changed since,
    is final even if its history disagrees with the listing (the two views need not agree for every
    item). Without this an irreconcilable item would be fetched every hour."""
    listing = {1: {D2: _row(1, 1), D3: _row(1, 1)}, 2: {D2: _row(5, 9), D3: _row(1, 1)}}
    stored = {1: {D2: _row(1, 1)}, 2: {D2: _row(5, 8)}}
    fp = {2: {"fp": sr.fingerprint(listing[2], D2), "through": D2}}
    a = sr.assess(listing, stored, fingerprints=fp)
    assert a.stale == set() and a.cut == D2


def test_a_fingerprint_taken_before_the_day_was_final_does_not_count():
    listing = {1: {D2: _row(1, 1), D3: _row(1, 1)}, 2: {D2: _row(5, 9), D3: _row(1, 1)}}
    stored = {1: {D2: _row(1, 1)}, 2: {D2: _row(5, 8)}}
    fp = {2: {"fp": sr.fingerprint(listing[2], D2), "through": D1}}
    assert sr.assess(listing, stored, fingerprints=fp).stale == {2}


def test_a_changed_listing_voids_the_fingerprint():
    listing = {1: {D2: _row(1, 1), D3: _row(1, 1)}, 2: {D2: _row(5, 9), D3: _row(1, 1)}}
    stored = {1: {D2: _row(1, 1)}, 2: {D2: _row(5, 8)}}
    fp = {2: {"fp": sr.fingerprint({D2: _row(5, 7)}, D2), "through": D2}}
    assert sr.assess(listing, stored, fingerprints=fp).stale == {2}


def test_todays_moving_numbers_are_not_part_of_the_fingerprint():
    """poe2scout's unfinished day changes all the time; if it counted, every item would look changed
    every hour and the poll would re-fetch the whole league each time."""
    assert sr.fingerprint({D2: _row(5, 9), D3: _row(1, 1)}, D2) == sr.fingerprint({D2: _row(5, 9), D3: _row(7, 7)}, D2)


def test_only_tracked_items_count_not_everything_poe2scout_lists():
    """Items we never crawled (below the price floor from the start) are not in the seed, so they
    neither block it nor get fetched."""
    listing = {1: {D2: _row(1, 1), D3: _row(1, 1)}, 8: {D2: _row(0.1, 1), D3: _row(0.1, 1)}}
    a = sr.assess(listing, {1: {D2: _row(1, 1)}}, fingerprints={})
    assert a.stale == set() and a.cut == D2


def test_an_irreconcilable_item_is_fetched_once_per_new_final_day_not_every_hour():
    """The fingerprint covers the days that were final when we fetched; a newer final day must
    still match (or be fetched once for it)."""
    listing = {1: {D1: _row(1, 1), D2: _row(1, 1), D3: _row(1, 1)}, 2: {D1: _row(5, 9), D2: _row(5, 9), D3: _row(1, 1)}}
    stored = {1: {D1: _row(1, 1), D2: _row(1, 1)}, 2: {D1: _row(5, 8), D2: _row(5, 9)}}
    fp = {2: {"fp": sr.fingerprint(listing[2], D1), "through": D1}}
    a = sr.assess(listing, stored, fingerprints=fp)
    assert a.stale == set() and a.cut == D2, "D1 via fingerprint, D2 by matching"


def test_a_tracked_item_absent_from_the_listing_is_stale_until_fetched_once():
    listing = {1: {D1: _row(1, 1), D2: _row(1, 1), D3: _row(1, 1)}}
    stored = {1: {D1: _row(1, 1), D2: _row(1, 1)}, 7: {D1: _row(4, 4)}}
    assert sr.assess(listing, stored, fingerprints={}).stale == {7}
    fp = {7: {"fp": sr.fingerprint({}, D2), "through": D2}}
    assert sr.assess(listing, stored, fingerprints=fp).stale == set()


def test_nothing_final_yet_means_no_day_can_ship():
    listing = {1: {D3: _row(1, 1)}}                                 # a brand-new league, day one
    a = sr.assess(listing, {1: {D3: _row(1, 1)}}, fingerprints={})
    assert a.cut is None
    assert sr.assess({}, {1: {}}, fingerprints={}).through is None


# ---------------------------------------------------------------- code review 2026-09-29
def test_the_listing_window_sliding_on_does_not_void_a_fingerprint():
    """The listing is a rolling week: its oldest day drops off daily. A vouch covers the days it saw;
    a day that left the window is not a change."""
    old = {D1: _row(5, 9), D2: _row(5, 9), D3: _row(1, 1)}
    fp = {2: {"fp": sr.fingerprint(old, D2), "through": D2}}
    listing = {1: {D2: _row(1, 1), D3: _row(1, 1)}, 2: {D2: _row(5, 9), D3: _row(1, 1)}}   # D1 slid off
    stored = {1: {D2: _row(1, 1)}, 2: {D2: _row(5, 8)}}
    a = sr.assess(listing, stored, fingerprints=fp)
    assert a.stale == set() and a.cut == D2


def test_a_refetch_that_did_not_fix_the_row_blocks_the_cut_but_is_not_refetched():
    """An item whose refetch came back empty or still disagrees is not final (it stays stale and
    holds the cut), yet it is not fetched again until poe2scout changes it."""
    listing = {1: {D2: _row(1, 1), D3: _row(1, 1)}, 2: {D2: _row(5, 9), D3: _row(1, 1)}}
    stored = {1: {D2: _row(1, 1)}, 2: {D2: _row(5, 8)}}
    fp = {2: {"fp": sr.fingerprint(listing[2], D2), "through": D2, "vouch": False}}
    a = sr.assess(listing, stored, fingerprints=fp)
    assert a.stale == {2} and a.cut < D2
    assert sr.to_fetch(a, listing, fp) == set()
    changed = {**listing, 2: {D2: _row(5, 10), D3: _row(1, 1)}}
    assert sr.to_fetch(sr.assess(changed, stored, fp), changed, fp) == {2}


# ---------------------------------------------------------------- owner, 2026-09-29: data integrity over speed
def test_an_item_without_a_next_day_row_has_usually_just_not_traded_yet():
    """poe2scout finishes a day for every item at once, so a league-wide judgement stands. Measured
    live 2026-09-29: 15 (Forbidden Rites) / 76 (Runes) items had no 09-28 row while poe2scout had
    posted ~19% of 09-28; they traded ~10 a day and their 09-27 rows were complete. A per-item test
    held the seed back up to four days on such items."""
    listing = {i: {D1: _row(1, 100), D2: _row(1, 100), D3: _row(1, 100), D4: _row(1, 19)} for i in range(9)}
    listing[9] = {D1: _row(1, 10), D2: _row(1, 10), D3: _row(1, 10)}
    assert sr.final_through(listing) == D3


def test_a_finished_day_poe2scout_changes_afterwards_is_counted():
    """The assumption is watched, not trusted: an item fetched a full day after a day ended (poe2scout
    was surely past it) whose row for that day no longer matches means poe2scout changed a finished
    day. Our own old partial rows (fetched before the day was finished) do not count."""
    import calendar
    at = lambda day, h: calendar.timegm(__import__("time").strptime(day, "%Y-%m-%d")) + h * 3600
    listing = {1: {D1: _row(1, 1), D2: _row(1, 1), D3: _row(1, 1)},
               2: {D1: _row(5, 9), D2: _row(1, 1), D3: _row(1, 1)},
               3: {D1: _row(5, 9), D2: _row(1, 1), D3: _row(1, 1)}}
    stored = {1: {D1: _row(1, 1), D2: _row(1, 1)}, 2: {D1: _row(5, 8), D2: _row(1, 1)}, 3: {D1: _row(5, 8), D2: _row(1, 1)}}
    fetched = {1: at(D3, 1), 2: at(D3, 1), 3: at(D1, 20)}        # 3 was fetched while D1 was still open
    assert sr.changed_after_final(listing, stored, fetched) == {2}
