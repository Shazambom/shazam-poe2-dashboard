"""The replays against the owner's own market DB are opt-in, so the deploy gate depends on the code only.

Audit 2026-09-29 (docs/bugs/2026-09-29-audit-open-items.md, H1): five files each pointed at
`~/Library/Application Support/Arbiter/data/market.sqlite` and ran whenever it existed; four tests
failed whenever the local app had not run in the last hour, blocking deploys over data, not code.
They now run only with ARBITER_PROD_TESTS=1 (and the DB present), from one definition.

    DATA_DIR=$(mktemp -d) MARKET_SEED= python -m pytest backend/tests/test_prod_replays_opt_in.py -q
"""
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
TESTS = Path(__file__).resolve().parent


def test_one_definition_of_the_owner_db():
    copies = [p.name for p in TESTS.glob("test_*.py")
              if p.name != Path(__file__).name and "PROD_DB = Path(" in p.read_text()]
    assert copies == [], f"own PROD_DB definitions: {copies}"


def test_replays_skip_unless_asked_for(monkeypatch, tmp_path):
    db = tmp_path / "market.sqlite"
    db.write_bytes(b"")
    monkeypatch.setenv("ARBITER_PROD_MARKET_DB", str(db))
    monkeypatch.delenv("ARBITER_PROD_TESTS", raising=False)
    import _proddb
    m = importlib.reload(_proddb)
    assert m.prod.args[0] is True, "a present DB alone must not turn the replays on"
    monkeypatch.setenv("ARBITER_PROD_TESTS", "1")
    assert importlib.reload(_proddb).prod.args[0] is False
