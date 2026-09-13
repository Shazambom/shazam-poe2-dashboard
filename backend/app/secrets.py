"""Encrypted credential storage.

Secrets (trade session cookie, OAuth tokens) are Fernet-encrypted with a key that is
generated on first run and kept in DATA_DIR/secret.key (mode 600). The ciphertext lives
in the kv table, so a copy of the database alone reveals nothing.
"""
from __future__ import annotations

import json
import os
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from . import db
from .config import DATA_DIR

KEY_PATH = DATA_DIR / "secret.key"


def _fernet() -> Fernet:
    if not KEY_PATH.exists():
        KEY_PATH.write_bytes(Fernet.generate_key())
        os.chmod(KEY_PATH, 0o600)
    return Fernet(KEY_PATH.read_bytes())


def store(name: str, value: Any) -> None:
    token = _fernet().encrypt(json.dumps(value).encode()).decode()
    db.kv_set(f"secret:{name}", token)


def load(name: str) -> Any | None:
    token = db.kv_get(f"secret:{name}")
    if not token:
        return None
    try:
        return json.loads(_fernet().decrypt(token.encode()))
    except (InvalidToken, ValueError):
        return None


def clear(name: str) -> None:
    db.kv_set(f"secret:{name}", "")
