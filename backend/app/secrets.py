"""Encrypted credential storage.

Secrets (trade session cookie, OAuth tokens) are Fernet-encrypted with a key that is
generated on first run and kept in DATA_DIR/secret.key (mode 600). The ciphertext lives
in the kv table, so a copy of the database alone reveals nothing.
"""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Callable
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from . import db
from .config import DATA_DIR

KEY_PATH = DATA_DIR / "secret.key"
# Guards only key-file creation/read/cache; never held across DB I/O.
_key_lock = threading.Lock()


_fernet_cache: tuple[str, int, Fernet] | None = None


def _fernet() -> Fernet:
    global _fernet_cache
    with _key_lock:
        if not KEY_PATH.exists():
            KEY_PATH.write_bytes(Fernet.generate_key())
            os.chmod(KEY_PATH, 0o600)
        st = KEY_PATH.stat()
        key_str = str(KEY_PATH)
        cached = _fernet_cache
        if cached and cached[0] == key_str and cached[1] == st.st_mtime_ns:
            return cached[2]
        f = Fernet(KEY_PATH.read_bytes())
        _fernet_cache = (key_str, st.st_mtime_ns, f)
        return f


def _decode(f: Fernet, token: str | None) -> Any | None:
    if not token:
        return None
    try:
        return json.loads(f.decrypt(token.encode()))
    except (InvalidToken, ValueError):
        return None


def _encode(f: Fernet, value: Any) -> str:
    return f.encrypt(json.dumps(value).encode()).decode()


def store(name: str, value: Any) -> None:
    token = _encode(_fernet(), value)
    db.kv_set(f"secret:{name}", token)


def load(name: str) -> Any | None:
    token = db.kv_get(f"secret:{name}")
    if not token:
        return None
    return _decode(_fernet(), token)


def update(name: str, fn: Callable[[Any | None], Any | None]) -> Any | None:
    """Atomically read-modify-write an encrypted secret inside one DB write transaction."""
    f = _fernet()
    outcome: list[Any] = []

    def apply(token: str | None) -> str:
        updated = fn(_decode(f, token))
        outcome.append(updated)
        return "" if updated is None else _encode(f, updated)

    db.kv_update(f"secret:{name}", apply, "")
    return outcome[-1]


def clear(name: str) -> None:
    db.kv_set(f"secret:{name}", "")
