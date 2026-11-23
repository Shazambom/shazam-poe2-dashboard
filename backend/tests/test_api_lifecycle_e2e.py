"""End-to-end HTTP lifecycle tests for every backend feature on a seeded SQLite fixture.

Unlike unit tests that call internal Python modules directly (or hit an empty DB), this suite
exercises the real FastAPI app over TestClient against an isolated populated market.sqlite +
user.sqlite covering every product tab and write/read/stream lifecycle:
  - Health, Status, Backfill, Diag, Currencies, Leagues
  - Board, CardDetail (/api/asset), LeagueArc, Arc, Signals + Ack
  - Stash Capital, Sales Ingest -> Capital Credit -> Idempotent Re-ingest, Settings, Recipes, GoldFees
  - Arbitrage Routes SSE stream (/api/routes/stream), Presets, Convert, Strat Calculator
  - Economy: Hold, Movers, Market (top, edges, history), Inflation (main, cross, marketcap)
  - Trading: Workspace CRUD + validation, legacy /api/watches 410, Mods pools/prices, RateLimits, Session

Run:  DATA_DIR=$(mktemp -d) MARKET_SEED= .venv-test/bin/python -m pytest backend/tests/test_api_lifecycle_e2e.py -v
"""
from __future__ import annotations

import json
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from app import arbitrage, db, gateway, holdscore, leaguearc, main, modpool, movers
from app.currencies import registry

LEAGUE = "Test League"
PAST_LEAGUE = "Past League"


def _seed_fixture(tmp_path: Path, monkeypatch) -> TestClient:
    user_db = tmp_path / "user.sqlite"
    market_db = tmp_path / "market.sqlite"

    monkeypatch.setattr(db, "USER_DB_PATH", user_db)
    monkeypatch.setattr(db, "MARKET_DB_PATH", market_db)
    monkeypatch.setattr(db, "MARKET_SEED_PATH", tmp_path / "missing-seed.sqlite.gz")
    monkeypatch.setattr(db, "_local", threading.local())
    monkeypatch.setattr(gateway, "_client", None)

    db._boot_databases()

    # Seed realistic currency registry, digest markets (48h), league_daily (2 leagues x 35d),
    # mod_pools, and analytics_cache (discords + arc).
    now_h = (int(time.time()) // 3600) * 3600
    currencies = [
        {"id": "exalted", "text": "Exalted Orb", "category": "currency", "image": "/img/ex.png"},
        {"id": "divine", "text": "Divine Orb", "category": "currency", "image": "/img/div.png"},
        {"id": "chaos", "text": "Chaos Orb", "category": "currency", "image": "/img/chaos.png"},
        {"id": "vaal", "text": "Vaal Orb", "category": "currency", "image": "/img/vaal.png"},
        {"id": "annul", "text": "Orb of Annulment", "category": "currency", "image": "/img/annul.png"},
        {"id": "mirror", "text": "Mirror of Kalandra", "category": "currency", "image": "/img/mirror.png"},
    ]
    with db.tx() as conn:
        conn.execute("INSERT OR REPLACE INTO kv VALUES('settings', ?)", (json.dumps({"league": LEAGUE}),))
        conn.execute("INSERT OR REPLACE INTO kv_ops VALUES('currencies_v1', ?)", (json.dumps(currencies),))
        conn.execute("INSERT OR REPLACE INTO kv_ops VALUES('lh_current', ?)", (json.dumps([LEAGUE]),))
        conn.execute(
            "INSERT OR REPLACE INTO kv_ops VALUES('trade_leagues', ?)",
            (json.dumps({"at": time.time(), "leagues": [{"id": LEAGUE, "text": LEAGUE}]}),),
        )

        # Build a liquid 6-currency exchange graph with realistic rates using real GGG metadata IDs:
        # 1 divine = 100 ex, 1 chaos = 5 ex, 1 divine = 20 chaos (plus mild 1% spread),
        # 1 vaal = 2 ex, 1 annul = 20 ex, 1 mirror = 500 divine.
        meta_of = {tid: registry.metas(tid)[0] for tid in ("exalted", "divine", "chaos", "vaal", "annul", "mirror")}
        pairs = [
            ("divine", "exalted", 1000, 100_000, 500, 50_000),
            ("chaos", "exalted", 5000, 25_000, 2000, 10_000),
            ("divine", "chaos", 800, 15_840, 400, 7_920),
            ("vaal", "exalted", 10_000, 20_000, 4_000, 8_000),
            ("annul", "exalted", 2_000, 40_000, 1_000, 20_000),
            ("annul", "divine", 1_000, 202, 500, 101),
            ("mirror", "divine", 20, 10_000, 10, 5_000),
        ]
        digest_rows = []
        for offset in range(48):
            h = now_h - offset * 3600
            drift = 1.0 + 0.002 * (offset % 12)
            for a, b, va, vb, hsa, hsb in pairs:
                ma, mb = meta_of[a], meta_of[b]
                digest_rows.append((
                    h, LEAGUE, f"{ma}|{mb}", ma, mb,
                    int(va), int(vb * drift),
                    None, None, hsa, hsb,
                    None, None, None, None,
                ))
        conn.executemany(
            "INSERT OR REPLACE INTO digest_markets VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            digest_rows,
        )

        # Item metadata + daily history for Hold, Inflation, LeagueArc
        items = [
            (291, "Divine Orb", "currency"),
            (290, "Exalted Orb", "currency"),
            (287, "Chaos Orb", "currency"),
            (292, "Vaal Orb", "currency"),
            (293, "Orb of Annulment", "currency"),
            (294, "Mirror of Kalandra", "currency"),
        ]
        conn.executemany("INSERT OR REPLACE INTO item_meta VALUES(?,?,?)", items)

        base_day = int(time.time()) - 35 * 86400
        daily_rows = []
        base_prices = {291: 100.0, 290: 1.0, 287: 5.0, 292: 2.0, 293: 20.0, 294: 50000.0}
        for i in range(35):
            day_cur = datetime.fromtimestamp(base_day + i * 86400, timezone.utc).strftime("%Y-%m-%d")
            day_past = datetime.fromtimestamp(1_600_000_000 + i * 86400, timezone.utc).strftime("%Y-%m-%d")
            for iid, bp in base_prices.items():
                mult = 1.0 + 0.01 * i
                daily_rows.append((LEAGUE, iid, day_cur, bp * mult, bp * mult, 50_000))
                daily_rows.append((PAST_LEAGUE, iid, day_past, bp * (0.9 + 0.012 * i), bp * (0.9 + 0.012 * i), 40_000))
        conn.executemany("INSERT OR REPLACE INTO league_daily VALUES(?,?,?,?,?,?)", daily_rows)

        # Mod pool fixture
        pool_data = {
            "id": "ring",
            "name": "Ring",
            "class": "Ring",
            "domain": "item",
            "prefixes": [{"id": "life", "text": "+# to maximum Life", "weight": 1000, "ilvl": 1, "tiers": []}],
            "suffixes": [{"id": "res", "text": "+#% to Fire Resistance", "weight": 1000, "ilvl": 1, "tiers": []}],
        }
        conn.execute(
            "INSERT OR REPLACE INTO mod_pools VALUES(?,?,?,?,?,?)",
            ("ring", "Ring", "Ring", "item", json.dumps(["ring"]), json.dumps(pool_data)),
        )
        conn.execute("INSERT OR REPLACE INTO mod_currencies VALUES('exalted', 'Exalted Orb', 1, NULL)")

        # Sidecar analytics cache (discords + arc)
        conn.execute(
            "INSERT OR REPLACE INTO analytics_cache VALUES('discords', 'current', ?, ?)",
            (int(time.time()), json.dumps({
                "league": LEAGUE,
                "signals": [{"item_id": 291, "name": "Divine Orb", "t": int(time.time()), "mp_dist": 12.5, "vol_z": 4.2, "close": 115.0}],
            })),
        )
        conn.execute(
            "INSERT OR REPLACE INTO analytics_cache VALUES('arc', 'current', ?, ?)",
            (int(time.time()), json.dumps({
                "league": LEAGUE,
                "weights": {PAST_LEAGUE: 1.0},
                "resembles": PAST_LEAGUE,
            })),
        )

    # Clear in-memory caches so endpoints read strictly from our isolated fixture
    arbitrage.invalidate_caches()
    holdscore.clear_cache() if hasattr(holdscore, "clear_cache") else None
    leaguearc.clear_cache() if hasattr(leaguearc, "clear_cache") else None
    movers.clear_cache() if hasattr(movers, "clear_cache") else None
    modpool._clear_cache() if hasattr(modpool, "_clear_cache") else None
    db._tx_gen += 1

    return TestClient(main.app)


@pytest.fixture
def seeded_client(tmp_path, monkeypatch):
    client = _seed_fixture(tmp_path, monkeypatch)
    try:
        yield client
    finally:
        client.close()
        gateway._client = None
        arbitrage.invalidate_caches()
        db._tx_gen += 1


def test_core_health_status_board_asset_and_signals_lifecycle(seeded_client):
    c = seeded_client

    # Health + status + backfill + diag + currencies + leagues
    assert c.get("/api/health").json() == {"ok": True}
    st = c.get("/api/status")
    assert st.status_code == 200
    assert st.json()["league"] == LEAGUE
    assert c.get("/api/backfill").status_code == 200
    assert c.get("/api/diag").status_code == 200
    assert c.get("/api/leagues").status_code == 200
    cur = c.get("/api/currencies")
    assert cur.status_code == 200 and len(cur.json()["currencies"]) >= 6

    # Board + CardDetail (/api/asset) + LeagueArc + Arc
    b = c.get("/api/board?window_h=24")
    assert b.status_code == 200
    bjson = b.json()
    assert len(bjson["rows"]) > 0
    asset = c.get("/api/asset?q=divine&window_h=24")
    assert asset.status_code == 200 and asset.json()["row"]["id"] == "divine"
    assert c.get("/api/leaguearc").status_code == 200
    assert c.get("/api/arc?item=Divine+Orb").status_code == 200

    # Signals lifecycle: read fired signal -> ack -> unseen drops to 0
    sigs = c.get("/api/signals")
    assert sigs.status_code == 200
    sdata = sigs.json()
    assert len(sdata["signals"]) == 1
    assert sdata["unseen"] >= 1
    ack = c.post("/api/signals/ack", json={"keys": [], "all": True})
    assert ack.status_code == 200 and ack.json()["unseen"] == 0
    assert c.get("/api/signals").json()["unseen"] == 0


def test_stash_capital_sales_credit_and_settings_lifecycle(seeded_client):
    c = seeded_client

    # Save initial capital via PUT /api/capital
    put_cap = c.put("/api/capital", json={"entries": {"divine": 10, "exalted": 500}, "counted": ["divine", "exalted"]})
    assert put_cap.status_code == 200
    cap = c.get("/api/capital").json()
    by_id = {r["currency"]: r["qty"] for r in cap["rows"]}
    assert by_id["divine"] == 10 and by_id["exalted"] == 500

    # Ingest a new sale that landed AFTER the recount -> credits capital once; re-ingest is idempotent
    sale_ts = datetime.fromtimestamp(time.time() + 10, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    sale = {
        "item_id": "sale-e2e-1",
        "time": sale_ts,
        "item": {"name": "Headhunter", "typeLine": "Heavy Belt"},
        "price": {"amount": 25, "currency": "divine"},
    }
    ing1 = c.post("/api/sales/ingest", json={"league": LEAGUE, "result": [sale]})
    assert ing1.status_code == 200
    d1 = ing1.json()
    assert d1["ok"] is True and d1["new"] == 1 and d1["credited"] == 1

    by_id_after = {r["currency"]: r["qty"] for r in c.get("/api/capital").json()["rows"]}
    assert by_id_after["divine"] == 35

    # Re-ingest same sale -> must NOT double-credit
    ing2 = c.post("/api/sales/ingest", json={"league": LEAGUE, "result": [sale]})
    assert ing2.status_code == 200 and ing2.json()["new"] == 0 and ing2.json()["credited"] == 0
    by_id_again = {r["currency"]: r["qty"] for r in c.get("/api/capital").json()["rows"]}
    assert by_id_again["divine"] == 35

    sales = c.get(f"/api/sales?league={LEAGUE}")
    assert sales.status_code == 200 and len(sales.json()["rows"]) == 1

    # Settings + Recipes + Goldfees + Presets
    assert c.put("/api/settings", json={"patch": {"stash_unit": "divine"}}).status_code == 200
    assert c.get("/api/settings").json()["stash_unit"] == "divine"
    assert c.get("/api/arbitrage/presets").status_code == 200
    assert c.get("/api/goldfees").status_code == 200
    rec = c.get("/api/recipes")
    assert rec.status_code == 200
    assert c.put("/api/recipes", json={"recipes": rec.json()}).status_code == 200


def test_arbitrage_stream_convert_and_strat_calc_lifecycle(seeded_client):
    c = seeded_client

    # Seed capital so routes have holdings
    c.put("/api/capital", json={"entries": {"exalted": 5000, "divine": 50}, "counted": []})

    # SSE /api/routes/stream emits valid meta + done events
    events = []
    with c.stream("GET", "/api/routes/stream?window_h=24&max_hops=3") as resp:
        assert resp.status_code == 200
        assert "text/event-stream" in resp.headers.get("content-type", "")
        cur_ev = None
        for line in resp.iter_lines():
            if line.startswith("event: "):
                cur_ev = line[7:].strip()
            elif line.startswith("data: "):
                events.append((cur_ev, json.loads(line[6:])))
    ev_names = [e[0] for e in events]
    assert "meta" in ev_names and "done" in ev_names

    # Convert endpoint returns a priced conversion
    conv = c.get("/api/convert?have=chaos&want=divine&amount=1000")
    assert conv.status_code == 200
    cdata = conv.json()
    assert cdata["best"] is not None and cdata["best"]["out"] > 0

    # Strat Calculator GET -> PUT (valid + invalid 422) -> GET round-trip + ?prices=1 fast poll
    sc0 = c.get("/api/strategy/calc")
    assert sc0.status_code == 200 and "prices" in sc0.json()
    assert c.get("/api/strategy/calc?prices=1").status_code == 200
    assert c.put("/api/strategy/calc", json={"calc": {"v": 999}}).status_code == 422
    payload = {
        "v": 1,
        "active": "s1",
        "lastCur": "divine",
        "strats": [{
            "id": "s1",
            "name": "Breach",
            "updatedAt": 1,
            "timer": {"startedAt": None, "elapsedMs": 0},
            "loot": [{"cur": "divine", "qty": 3, "price": None}],
            "fixed": [],
            "maps": {"count": 10, "price": None, "cur": "exalted"},
            "tablets": {"lines": []},
            "override": {"on": False, "amount": 0, "cur": "divine"},
        }],
        "tree": [{"id": "s1", "kind": "strat"}],
    }
    put_sc = c.put("/api/strategy/calc", json={"calc": payload})
    assert put_sc.status_code == 200
    assert c.get("/api/strategy/calc").json()["calc"]["active"] == "s1"


def test_economy_hold_movers_market_and_inflation_lifecycle(seeded_client):
    c = seeded_client

    assert c.get("/api/hold?window_h=24").status_code == 200
    assert c.get("/api/movers?window_h=24").status_code == 200

    top = c.get("/api/market/top")
    assert top.status_code == 200 and len(top.json()) > 0
    edges = c.get("/api/market/edges")
    assert edges.status_code == 200 and len(edges.json()) > 0
    hist = c.get("/api/market/history?a=divine&b=exalted&hours=48")
    assert hist.status_code == 200 and len(hist.json()["digest"]) > 0

    assert c.get("/api/inflation?anchor=divine&hours=168").status_code == 200
    assert c.get("/api/inflation/cross?item=291").status_code == 200
    assert c.get("/api/inflation/marketcap").status_code == 200


def test_trading_workspace_mods_ratelimits_and_session_lifecycle(seeded_client):
    c = seeded_client

    # Workspace GET -> PUT -> GET round-trip; legacy PUT /api/watches must return 410
    ws0 = c.get("/api/trading/workspace")
    assert ws0.status_code == 200 and ws0.json()["workspace"]["version"] == 2
    ws_doc = {
        "version": 2,
        "tree": [{"id": "s1", "kind": "search", "name": "Divines", "slug": "abc123", "live": False}],
        "layout": {"collapsed": False},
        "openTabs": ["s1"],
    }
    assert c.put("/api/trading/workspace", json={"workspace": ws_doc}).status_code == 200
    assert c.get("/api/trading/workspace").json()["workspace"]["tree"][0]["slug"] == "abc123"
    assert c.get("/api/watches").status_code == 200
    assert c.put("/api/watches", json={"folders": []}).status_code == 410

    # Mods pools + single pool + pool prices + 404 on unknown pool
    pools = c.get("/api/mods/pools")
    assert pools.status_code == 200 and any(p["id"] == "ring" for p in pools.json()["pools"])
    assert c.get("/api/mods/pool/ring").status_code == 200
    assert c.get("/api/mods/pool/ring/prices").status_code == 200
    assert c.get("/api/mods/pool/nonexistent").status_code == 404

    # Rate-limits acquire + observe + status
    rl = c.get("/api/ratelimits")
    assert rl.status_code == 200 and "trade-search" in rl.json()["policies"]
    assert c.post("/api/ratelimits/acquire", json={"policy": "trade-search", "spare": 0.0}).status_code == 200
    assert c.post("/api/ratelimits/observe", json={"policy": "trade-search", "status": 200, "headers": {}}).status_code == 200

    # Session status + delete (read/clear without touching remote PoE servers)
    assert c.get("/api/session").status_code == 200
    assert c.delete("/api/session").status_code == 200
