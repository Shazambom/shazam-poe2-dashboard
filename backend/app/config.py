import os
from pathlib import Path


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Two-DB split: user data persists+migrates, market data is disposable/snapshot-seeded.
USER_DB_PATH = DATA_DIR / "user.sqlite"
MARKET_DB_PATH = DATA_DIR / "market.sqlite"
# Legacy single-file DB (pre-split). Kept for the one-time migration that lifts the
# user's rows out of it; renamed to *.premigration afterwards, never deleted.
DB_PATH = DATA_DIR / "poe2arb.sqlite"
# Bundled market snapshot (Electron sets MARKET_SEED to the extraResources path). Empty
# in dev/server -> no seed, just crawl live.
_seed = os.environ.get("MARKET_SEED", "").strip()
MARKET_SEED_PATH = Path(_seed) if _seed else None

RECIPES_PATH = DATA_DIR / "recipes.json"
SEED_DIR = Path(__file__).resolve().parent.parent / "data"

LEAGUE = os.environ.get("LEAGUE", "Standard")
# Legacy fallback only; connect the session from the dashboard instead.
POESESSID = os.environ.get("POESESSID", "").strip()
USER_AGENT = os.environ.get(
    "USER_AGENT", "poe2-arb-dashboard/0.1 (self-hosted; contact: set USER_AGENT in .env)"
)

# GGG hourly digest: how far back to backfill on first run, and poll cadence.
DIGEST_BACKFILL_HOURS = _int("DIGEST_BACKFILL_HOURS", 168)
DIGEST_POLL_SECONDS = _int("DIGEST_POLL_SECONDS", 300)

# Live order book: seconds between pair fetches and between full watchlist sweeps.
ORDERBOOK_MIN_GAP_SECONDS = _int("ORDERBOOK_MIN_GAP_SECONDS", 6)
ORDERBOOK_SWEEP_SECONDS = _int("ORDERBOOK_SWEEP_SECONDS", 600)

GGG_DIGEST_URL = "https://web.poecdn.com/api/currency-exchange/poe2"
TRADE_STATIC_URL = "https://www.pathofexile.com/api/trade2/data/static"
TRADE_EXCHANGE_URL = "https://www.pathofexile.com/api/trade2/exchange"
