"""What a "Report a problem" file needed and lacked (reading report FY0M4R, 2026-10-02):
- the backend log covered ~5 minutes, nearly all successful GET polls (/api/status, /api/backfill), so
  the league switch and everything before it had scrolled out: successful reads are not logged (on the
  desktop), writes and every error still are;
- nothing recorded WHEN a setting changed (the user switched league just before reporting): each saved
  change is one log line, key and value;
- diag counted league history only in total and for the current league (0 on Standard), so "which
  leagues have history" took a second round trip: rows and day range per league;
- diag counted the registry, not the gap: the traded items the app cannot name (Raven's Reflection
  was the most traded of them) are listed with their volume."""
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # backend/
from app import accesslog, db, diag, settings  # noqa: E402
from app.currencies import registry  # noqa: E402


def _access(method, path, status):
    return logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
                             ("127.0.0.1:5", method, path, "1.1", status), None)


def test_successful_reads_are_quiet_writes_and_errors_are_logged():
    f = accesslog.QuietReads()
    assert not f.filter(_access("GET", "/api/status", 200))
    assert not f.filter(_access("GET", "/api/backfill", 304))
    assert f.filter(_access("PUT", "/api/settings", 200)), "a write is an event"
    assert f.filter(_access("POST", "/api/ratelimits/acquire", 200))
    assert f.filter(_access("GET", "/api/hold", 500)), "a failed read is an event"
    assert f.filter(_access("GET", "/api/x", 404))
    assert f.filter(logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, "odd line", None, None)), "unknown shapes pass"


def test_the_desktop_entrypoint_installs_it():
    src = (Path(__file__).resolve().parents[1] / "run_desktop.py").read_text()
    assert "accesslog.install()" in src


def test_install_is_idempotent():
    lg = logging.getLogger("uvicorn.access")
    before = list(lg.filters)
    try:
        accesslog.install()
        accesslog.install()
        assert sum(isinstance(x, accesslog.QuietReads) for x in lg.filters) == 1
    finally:
        lg.filters[:] = before


def test_a_saved_change_is_one_log_line(caplog):
    db.kv_set("settings", {"league": "Standard"})
    try:
        with caplog.at_level(logging.INFO, logger="app.settings"):
            settings.save_settings({"league": "Forbidden Rites", "watchlist": ["chaos"], "reference": "exalted"})
        lines = [r.getMessage() for r in caplog.records if r.name == "app.settings"]
        assert "settings: league 'Standard' → 'Forbidden Rites'" in lines
        assert "settings: watchlist changed" in lines, "a list or object is named, not dumped"
        assert not any("reference" in x for x in lines), "an unchanged value is not a change"
    finally:
        db.kv_set("settings", {})


def test_diag_lists_league_history_per_league():
    with db.tx() as c:
        c.execute("DELETE FROM league_daily")
        c.executemany("INSERT INTO league_daily(league, item_id, day, close, average, volume) VALUES (?,?,?,?,?,?)",
                      [("Runes of Aldur", 1, "2026-05-29", 1, 1, 1), ("Runes of Aldur", 2, "2026-06-01", 1, 1, 1),
                       ("Forbidden Rites", 1, "2026-09-04", 1, 1, 1)])
    try:
        assert diag._league_history() == {
            "Forbidden Rites": {"rows": 1, "items": 1, "first": "2026-09-04", "last": "2026-09-04"},
            "Runes of Aldur": {"rows": 2, "items": 2, "first": "2026-05-29", "last": "2026-06-01"}}
    finally:
        with db.tx() as c:
            c.execute("DELETE FROM league_daily")


def test_diag_lists_the_traded_items_the_app_cannot_name_by_volume(monkeypatch):
    known = {"Metadata/Items/Currency/CurrencyRerollRare": "chaos", "Metadata/Items/Currency/CurrencyModValues": "divine"}
    monkeypatch.setattr(registry, "resolve_meta", lambda m: known.get(m))
    now = 1_790_000_000 // 3600 * 3600
    rows = [(now, "L", "m1", "Metadata/Items/Currency/CurrencyRerollRare", "Metadata/Items/Currency/Delirium/DeliriumPinnacleKey", 50, 900),
            (now, "L", "m2", "Metadata/Items/Currency/CurrencyModValues", "Metadata/Items/Currency/Delirium/DeliriumPinnacleKey", 10, 100),
            (now, "L", "m3", "Metadata/Items/Currency/CurrencyRerollRare", "Metadata/Items/SoulCores/IdolHawk", 5, 7),
            (now, "L", "m4", "Metadata/Items/Currency/CurrencyRerollRare", "Metadata/Items/Currency/CurrencyModValues", 1, 1),
            (now - 48 * 3600, "L", "m5", "Metadata/Items/Currency/CurrencyRerollRare", "Metadata/Items/Old/Gone", 1, 99999),
            (now, "Other", "m6", "Metadata/Items/Currency/CurrencyRerollRare", "Metadata/Items/Elsewhere", 1, 99999)]
    with db.tx() as c:
        c.execute("DELETE FROM digest_markets")
        c.executemany("INSERT INTO digest_markets(hour, league, market_id, cur_a, cur_b, vol_a, vol_b) VALUES (?,?,?,?,?,?,?)", rows)
    try:
        assert diag._unknown_traded("L", now=now) == [
            {"meta": "Metadata/Items/Currency/Delirium/DeliriumPinnacleKey", "volume_24h": 1000},
            {"meta": "Metadata/Items/SoulCores/IdolHawk", "volume_24h": 7}]
    finally:
        with db.tx() as c:
            c.execute("DELETE FROM digest_markets")
