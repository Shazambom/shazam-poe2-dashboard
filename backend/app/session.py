"""Trade-site session (POESESSID) for the live order book.

The exchange endpoint is outside GGG's OAuth API and only accepts the website's own
session cookie. The cookie is HttpOnly, so it can't be read by page script; it comes
in either by pasting it into Settings or by running tools/connect.py on the machine
whose browser is logged in. It is stored encrypted; the POESESSID env var is honoured
only as a legacy fallback.
"""
from __future__ import annotations

import time

from . import gateway, secrets
from .config import POESESSID, TRADE_EXCHANGE_URL
from .settings import get_settings


def get_cookie() -> str | None:
    rec = secrets.load("poesessid")
    if rec and rec.get("cookie"):
        return rec["cookie"]
    return POESESSID or None


def source() -> str | None:
    rec = secrets.load("poesessid")
    if rec and rec.get("cookie"):
        return "dashboard"
    return "env" if POESESSID else None


def status() -> dict:
    rec = secrets.load("poesessid") or {}
    return {
        "connected": bool(get_cookie()),
        "source": source(),
        "set_at": rec.get("set_at"),
        "last_ok": rec.get("last_ok"),
        "label": rec.get("label"),
    }


async def validate(cookie: str) -> tuple[bool, str]:
    """One cheap exchange query: 401/403 means the cookie is bad."""
    league = get_settings()["league"]
    body = {"query": {"status": {"option": "online"}, "have": ["exalted"], "want": ["chaos"]},
            "sort": {"have": "asc"}, "engine": "new"}
    try:
        from . import orderbook
        r = await orderbook.exchange_post(league, body, cookie, retries=0)
    except gateway.RateLimited as exc:
        return True, f"session stored; verification deferred ({exc})"
    except Exception as exc:
        return False, f"could not reach the trade site: {exc}"
    if r.status_code in (401, 403):
        return False, "the trade site rejected this session; log in on pathofexile.com and copy the cookie again"
    if r.status_code == 429:
        return True, "session accepted (rate limited right now, so not fully verified)"
    if r.status_code >= 400:
        return False, f"trade site returned {r.status_code}"
    return True, "session verified against the exchange"


async def connect(cookie: str, label: str | None = None) -> dict:
    cookie = cookie.strip().strip('"').strip()
    if not cookie:
        raise ValueError("empty cookie")
    ok, msg = await validate(cookie)
    if not ok:
        raise ValueError(msg)
    secrets.store("poesessid", {"cookie": cookie, "set_at": time.time(), "last_ok": time.time(), "label": label})
    return status() | {"message": msg}


def mark_ok() -> None:
    rec = secrets.load("poesessid")
    if rec:
        rec["last_ok"] = time.time()
        secrets.store("poesessid", rec)


def disconnect() -> dict:
    secrets.clear("poesessid")
    return status()
