"""The owner's own market DB, for the replays that check a rule against real league data.

Opt-in: they run only with ARBITER_PROD_TESTS=1 and the DB present, so `ops/run-tests.sh` (the deploy
gate) depends on the code, not on whether this machine's app ran in the last hour (audit 2026-09-29).

    ARBITER_PROD_TESTS=1 python -m pytest backend/tests -q -k prod
"""
import os
from pathlib import Path

import pytest

PROD_DB = Path(os.environ.get(
    "ARBITER_PROD_MARKET_DB",
    Path.home() / "Library/Application Support/Arbiter/data/market.sqlite"))
_asked = os.environ.get("ARBITER_PROD_TESTS") == "1"
prod = pytest.mark.skipif(not (_asked and PROD_DB.exists()),
                          reason=f"owner-DB replay: set ARBITER_PROD_TESTS=1 (DB at {PROD_DB})")
