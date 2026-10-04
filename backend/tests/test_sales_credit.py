"""A sale credits the holdings only when the user's typed amount of that currency cannot already count it.

Owner report (0.3.12-beta.1, Windows): the stash went from about 300 div to over 1000 div on update. That
app had last fetched before 2026-10-01; after the update it caught up on 29 sales (01 → 04 Oct, 373 div,
one of them 250 div) and credited every one, though the user had set their holdings by hand after many of
them. These tests drive the same two endpoints the app uses: the Stash save (PUT /api/capital, `counted` =
the currencies whose total the user typed) and the fetch's hand-off (POST /api/sales/ingest).

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_sales_credit.py -q
"""
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from starlette.testclient import TestClient  # noqa: E402
from app import db, datapolicy  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)
LEAGUE = "Credit-tests"
STAMPS = "capital_counted_at"


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")   # how the trade site writes a sale's time (whole seconds)


def _ago(**kw) -> str:
    return _iso(datetime.now(timezone.utc) - timedelta(**kw))


def _sale(item_id: str, amount: float, currency: str, when: str) -> dict:
    return {"item_id": item_id, "time": when, "item": {"name": "Soul Grasp", "typeLine": "Runeforged Blacksteel Gauntlets"},
            "price": {"amount": amount, "currency": currency}}


def _save(entries: dict, counted=None) -> None:
    """The Stash's autosave. By default the user typed every total (a recount); the add bar and the
    Stash's own re-saves send `counted=[]`."""
    body = {"entries": entries, "counted": list(entries) if counted is None else counted}
    assert client.put("/api/capital", json=body).status_code == 200


def _fetch(rows: list[dict], **extra) -> dict:
    r = client.post("/api/sales/ingest", json={"league": LEAGUE, "result": rows, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def _stamps(**ago) -> None:
    """Counting state set directly: {currency: minutes ago}."""
    now = datetime.now(timezone.utc)
    db.kv_set(STAMPS, {k: (now - timedelta(minutes=m)).isoformat() for k, m in ago.items()})


def setup_function():
    db.kv_set(STAMPS, None)
    with db.tx() as c:
        c.execute("DELETE FROM sales WHERE league=?", (LEAGUE,))
        c.execute("DELETE FROM capital")


teardown_function = setup_function


def test_sales_made_before_the_user_set_their_holdings_are_not_credited_again():
    # The owner's Windows case, small: a 250 div sale two days ago, then the user counts their stash
    # (300 div, which already includes the 250) and types it in. The app fetches only now.
    _save({"divine": 300})
    got = _fetch([_sale("before-save", 250, "divine", _ago(days=2))])
    assert got["new"] == 1, "the sale still goes into the ledger"
    assert db.get_capital() == {"divine": 300}, "the typed 300 already counts the 250"
    assert got["credited"] == 0 and got["added"] == {}


def test_a_sale_made_after_the_user_set_their_holdings_is_credited():
    _save({"divine": 300})
    got = _fetch([_sale("after-save", 25, "divine", _ago(seconds=-5))])
    assert db.get_capital() == {"divine": 325}
    assert got["credited"] == 1 and got["added"] == {"divine": 25}, "the Stash adds exactly this to what is typed"


def test_a_catch_up_fetch_credits_only_the_sales_after_the_save():
    # The 29-sale catch-up: sales on both sides of the user's last save arrive in one fetch.
    _save({"divine": 300, "chaos": 50})
    got = _fetch([
        _sale("old-a", 250, "divine", _ago(days=2)),
        _sale("old-b", 30, "divine", _ago(days=1)),
        _sale("new-a", 20, "divine", _ago(seconds=-5)),
        _sale("new-b", 4, "chaos", _ago(seconds=-5)),
    ])
    assert db.get_capital() == {"divine": 320, "chaos": 54}
    assert got["added"] == {"divine": 20, "chaos": 4}


def test_a_fresh_install_does_not_credit_the_whole_merchant_history():
    # Nothing ever counted, nothing typed: the trade site hands back up to 100 old sales.
    _fetch([_sale(f"fresh-{i}", 10, "divine", _ago(days=3, minutes=i)) for i in range(100)])
    assert db.get_capital() == {}, "100 old sales x 10 div must not appear as 1000 new div"


def test_an_install_from_before_this_rule_credits_only_sales_after_its_first_fetch():
    # Upgrading: holdings exist, but no count time was ever recorded. The catch-up fetch credits nothing
    # older (it can't tell which the typed amount counts); a sale after it is credited as before.
    with db.tx() as c:
        c.execute("INSERT INTO capital(currency, qty) VALUES('divine', 300)")
    _fetch([_sale("upgrade-old", 250, "divine", _ago(days=2))])
    assert db.get_capital() == {"divine": 300}
    _fetch([_sale("upgrade-new", 20, "divine", _ago(seconds=-5))])
    assert db.get_capital() == {"divine": 320}


def test_each_currency_keeps_its_own_count():
    # Divines typed 10 minutes ago, chaos just now: a divine sale 5 minutes ago is new money.
    _stamps(**{"*": 60, "divine": 10})
    _save({"divine": 300, "chaos": 60}, counted=["chaos"])
    _fetch([_sale("per-currency", 25, "divine", _ago(minutes=5))])
    assert db.get_capital() == {"divine": 325, "chaos": 60}


def test_adding_with_the_add_bar_is_not_a_recount():
    # Divines typed three days ago; a 50 div sale yesterday, not fetched yet; today the user adds 10 divine
    # of loot with the add bar. The sale is not in the typed 300, so it is still new money.
    _stamps(**{"*": 60 * 24 * 5, "divine": 60 * 24 * 3})
    _save({"divine": 300}, counted=[])            # the restore of the starting amount: not a recount either
    _save({"divine": 310}, counted=[])            # the add bar
    _fetch([_sale("before-add", 50, "divine", _ago(days=1))])
    assert db.get_capital() == {"divine": 360}


def test_the_stash_resaving_a_credit_is_not_the_user_recounting():
    _stamps(**{"*": 60, "divine": 30})
    _fetch([_sale("resave-a", 10, "divine", _ago(minutes=20))])
    _save(db.get_capital(), counted=[])           # the Stash's re-save after the credit
    _fetch([_sale("resave-b", 5, "divine", _ago(minutes=10))])
    assert db.get_capital() == {"divine": 15}


def test_the_users_save_moves_the_line_not_only_the_first_fetch():
    # Counting began ten days ago; the user re-counts their divines today. A divine sale from two days ago
    # is in that count.
    _stamps(**{"*": 60 * 24 * 10, "divine": 60 * 24 * 10})
    _save({"divine": 300})
    _fetch([_sale("long-running", 40, "divine", _ago(days=2))])
    assert db.get_capital() == {"divine": 300}


def test_a_slow_pc_clock_does_not_credit_a_sale_the_count_includes():
    # The PC runs 5 minutes slow. The user types their divines; a sale made 2 minutes BEFORE that (by the
    # trade site's clock) is in the count, though its time reads after the PC's stamp. The fetch passes the
    # trade site's own clock time, which shows the skew.
    _save({"divine": 300})
    pc_now = datetime.now(timezone.utc)
    site_now = pc_now + timedelta(minutes=5)
    sold = _iso(site_now - timedelta(minutes=2))
    _fetch([_sale("slow-pc", 30, "divine", sold)], server_time=site_now.isoformat())
    assert db.get_capital() == {"divine": 300}


def test_a_fast_pc_clock_still_credits_a_sale_made_after_the_count():
    # The PC runs 5 minutes fast: a sale made 2 minutes AFTER the user typed reads before the PC's stamp.
    _save({"divine": 300})
    site_now = datetime.now(timezone.utc) - timedelta(minutes=5)
    sold = _iso(site_now + timedelta(seconds=5))
    _fetch([_sale("fast-pc", 30, "divine", sold)], server_time=site_now.isoformat())
    assert db.get_capital() == {"divine": 330}


def test_a_sale_time_that_cannot_be_read_is_recorded_but_never_breaks_the_fetch():
    _save({"divine": 300})
    got = _fetch([_sale("bad-time", 5, "divine", "yesterday"), _sale("naive-time", 7, "divine", "2099-01-01T00:00:00"),
                  _sale("good", 3, "divine", _ago(seconds=-5))])
    assert got["new"] == 3
    assert db.get_capital() == {"divine": 303}, "only the sale whose time can be read and is after the count"


def test_the_count_times_are_user_data():
    assert datapolicy.is_user_kv(STAMPS)
