"""User-database migrations (user.sqlite).

User data is migrated forward, never dropped: numbered, ordered, forward-only,
idempotent, data-preserving. See docs/db-maintenance.md for the rulebook.

Each migration is `(id, description, fn)` where `fn(conn)` receives the write
connection. The runner in db.py applies every migration with id > the stored
`user_meta.schema_version`, each in its own transaction, then advances the version.

RULES:
- Append only. Never renumber or edit a shipped migration (users may be past it).
- Make fns idempotent where cheap (CREATE TABLE IF NOT EXISTS, guard ALTER with a
  PRAGMA table_info check) so a half-applied migration re-runs safely.
"""
from __future__ import annotations

import json
import logging
import sqlite3

from .config import DB_PATH

log = logging.getLogger("poe2arb.migrate")

# kv keys that belong to the user (mirrors _USER_KV in db.py). Kept local so this
# module has no import cycle with db.py. `secret:` is handled by prefix below.
_LEGACY_USER_KV = {"settings", "watches", "oauth_pending", "meta_overrides"}


def _is_user_kv(key: str) -> bool:
    return key in _LEGACY_USER_KV or key.startswith("secret:")


def _m1_split_from_legacy(conn: sqlite3.Connection) -> None:
    """One-time split: lift the user's rows out of the pre-split poe2arb.sqlite into
    user.sqlite. Market rows are intentionally NOT copied — market.sqlite comes from
    the bundled seed (fresh full history) or a live crawl. Idempotent: guarded by
    user_meta.split_done and only reads the legacy file if it still exists.

    secret.key stays in DATA_DIR untouched, so the copied secret:* blobs remain
    decryptable and the user's PoE session/oauth survive the split.
    """
    done = conn.execute(
        "SELECT value FROM user_meta WHERE key='split_done'"
    ).fetchone()
    if done and done[0] == "1":
        return
    if not DB_PATH.exists():
        # Fresh install, no legacy DB — nothing to lift. Mark done so we don't re-check.
        conn.execute(
            "INSERT OR REPLACE INTO user_meta(key, value) VALUES('split_done','1')"
        )
        return

    log.info("legacy split: lifting user rows out of %s", DB_PATH)
    legacy = sqlite3.connect(str(DB_PATH), timeout=30)
    legacy.row_factory = sqlite3.Row
    try:
        # capital — all rows are user-owned.
        try:
            rows = legacy.execute("SELECT currency, qty FROM capital").fetchall()
            for r in rows:
                conn.execute(
                    "INSERT INTO capital(currency, qty) VALUES(?, ?) "
                    "ON CONFLICT(currency) DO UPDATE SET qty=excluded.qty",
                    (r["currency"], r["qty"]),
                )
            log.info("legacy split: copied %d capital rows", len(rows))
        except sqlite3.OperationalError:
            pass  # legacy DB predates the capital table

        # kv — only the user keys; operational keys are disposable (come from the seed).
        try:
            rows = legacy.execute("SELECT key, value FROM kv").fetchall()
            n = 0
            for r in rows:
                if _is_user_kv(r["key"]):
                    conn.execute(
                        "INSERT INTO kv(key, value) VALUES(?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                        (r["key"], r["value"]),
                    )
                    n += 1
            log.info("legacy split: copied %d user kv rows", n)
        except sqlite3.OperationalError:
            pass
    finally:
        legacy.close()

    conn.execute(
        "INSERT OR REPLACE INTO user_meta(key, value) VALUES('split_done','1')"
    )
    # Rename the legacy file so we never touch it again but keep it as a safety backup.
    backup = DB_PATH.with_suffix(DB_PATH.suffix + ".premigration")
    try:
        # Move the WAL/SHM sidecars too so the .premigration copy is self-consistent.
        for suffix in ("", "-wal", "-shm"):
            src = DB_PATH.parent / (DB_PATH.name + suffix)
            if src.exists():
                src.rename(backup.parent / (backup.name + suffix))
        log.info("legacy split: renamed %s -> %s", DB_PATH.name, backup.name)
    except OSError as exc:
        log.warning("legacy split: could not rename legacy DB (non-fatal): %s", exc)


USER_MIGRATIONS: list[tuple[int, str, object]] = [
    (1, "initial split from legacy poe2arb.sqlite", _m1_split_from_legacy),
]
