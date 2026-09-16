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
from .datapolicy import is_user_kv as _is_user_kv

log = logging.getLogger("poe2arb.migrate")


def watches_to_workspace(folders: list) -> dict:
    """Pure transform: flat `watches` folders[] -> the nested `trading_workspace` v2 doc.
    Shared by migration #2 and the read-time coercion in main.py. Preserves every folder
    and search (ids, titles, {type,slug,live,done}); the league is still injected at open
    time (never stored)."""
    tree = []
    for f in folders or []:
        if not isinstance(f, dict):
            continue
        children = []
        for s in f.get("searches", []) or []:
            if not isinstance(s, dict):
                continue
            children.append({
                "id": "n_" + str(s.get("id", "")),
                "kind": "search",
                "name": s.get("title", "Search"),
                "type": s.get("type", "search"),
                "slug": s.get("slug", ""),
                "live": bool(s.get("live", False)),
                "done": bool(s.get("done", False)),
                "notify": {"sound": True, "orb": True, "os": True},
            })
        tree.append({
            "id": "n_" + str(f.get("id", "")),
            "kind": "folder",
            "name": f.get("title", "Folder"),
            "open": f.get("open", True) is not False,
            "children": children,
        })
    return {"version": 2, "tree": tree, "layout": None, "openTabs": []}


def _m2_watches_to_workspace(conn: sqlite3.Connection) -> None:
    """Forward-only, idempotent, data-preserving: derive `trading_workspace` (v2 nested
    tree) from the legacy flat `watches` kv blob. Leaves `watches` untouched as a backup
    (roll-forward posture: fix this transform and re-derive, never revert user data)."""
    existing = conn.execute("SELECT value FROM kv WHERE key='trading_workspace'").fetchone()
    if existing:
        return  # idempotent
    row = conn.execute("SELECT value FROM kv WHERE key='watches'").fetchone()
    try:
        folders = json.loads(row[0]) if row and row[0] else []
        if not isinstance(folders, list):
            folders = []
    except (ValueError, TypeError):
        log.warning("m2: watches blob unparseable; seeding empty workspace (legacy left intact)")
        folders = []
    ws = watches_to_workspace(folders)
    conn.execute("INSERT INTO kv(key, value) VALUES('trading_workspace', ?)", (json.dumps(ws),))
    log.info("m2: derived trading_workspace with %d folders (watches kept as backup)", len(ws["tree"]))


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
    backup = DB_PATH.with_suffix(DB_PATH.suffix + ".premigration")
    if not DB_PATH.exists():
        if backup.exists():
            # The live file was renamed but split_done never landed (a crash between the rename
            # and the commit on an older build). Refuse to stamp "done" over a lift that never
            # happened — restore the backup by hand (mv it back to poe2arb.sqlite) and re-run.
            raise RuntimeError(
                f"legacy split: {backup.name} exists but the lift never committed; "
                f"restore it to {DB_PATH.name} and restart")
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

    def _rename_legacy() -> None:
        # Runs only AFTER the lift is committed (the runner calls it post-commit): if the commit
        # fails or the process dies first, the legacy file is still in place and the next boot
        # simply lifts again. Keeps the file as a safety backup; moves the WAL/SHM sidecars too
        # so the .premigration copy is self-consistent.
        try:
            for suffix in ("", "-wal", "-shm"):
                src = DB_PATH.parent / (DB_PATH.name + suffix)
                if src.exists():
                    src.rename(backup.parent / (backup.name + suffix))
            log.info("legacy split: renamed %s -> %s", DB_PATH.name, backup.name)
        except OSError as exc:
            log.warning("legacy split: could not rename legacy DB (non-fatal): %s", exc)

    return _rename_legacy


def _m3_liq_floor(conn: sqlite3.Connection) -> None:
    """One-time: bake the per-step liquidity/volume minimums into filters saved before they
    existed (they'd otherwise keep overriding the newer defaults with 0). Idempotent on the
    `_liq_floor_v1` marker; after it the user is free to lower them and it sticks. This used
    to be a write-on-read shim inside settings.get_settings() — a getter must not write."""
    row = conn.execute("SELECT value FROM kv WHERE key='settings'").fetchone()
    if not row:
        return
    try:
        s = json.loads(row[0])
    except (ValueError, TypeError):
        return
    if not isinstance(s, dict) or s.get("_liq_floor_v1"):
        return
    f = s.setdefault("filters", {})
    if isinstance(f, dict):
        f["min_liquidity_ref"] = max(f.get("min_liquidity_ref") or 0.0, 50.0)
        f["min_volume_ref_per_h"] = max(f.get("min_volume_ref_per_h") or 0.0, 100.0)
    s["_liq_floor_v1"] = True
    conn.execute("UPDATE kv SET value=? WHERE key='settings'", (json.dumps(s),))
    log.info("m3: baked liquidity/volume floors into saved filters")


def _m4_notifications(conn: sqlite3.Connection) -> None:
    """Fold the legacy `ping_sound` / `ping_volume` settings keys into the per-family
    `notifications` object (both families inherit the old sound switch; volume carries over),
    then drop the old keys. Idempotent: no-op once they are gone."""
    row = conn.execute("SELECT value FROM kv WHERE key='settings'").fetchone()
    if not row:
        return
    try:
        s = json.loads(row[0])
    except (ValueError, TypeError):
        return
    if not isinstance(s, dict) or not ({"ping_sound", "ping_volume"} & set(s)):
        return
    n = s.setdefault("notifications", {})
    if "ping_sound" in s:
        on = bool(s.pop("ping_sound"))
        n.setdefault("live", {})["sound"] = on
        n.setdefault("signals", {})["sound"] = on
    if "ping_volume" in s:
        n["volume"] = s.pop("ping_volume")
    conn.execute("UPDATE kv SET value=? WHERE key='settings'", (json.dumps(s),))
    log.info("m4: folded ping_sound/ping_volume into settings.notifications")


USER_MIGRATIONS: list[tuple[int, str, object]] = [
    (1, "initial split from legacy poe2arb.sqlite", _m1_split_from_legacy),
    (2, "derive trading_workspace tree from flat watches", _m2_watches_to_workspace),
    (3, "bake liquidity/volume filter floors into pre-floor settings", _m3_liq_floor),
    (4, "fold ping_sound/ping_volume into settings.notifications", _m4_notifications),
]
