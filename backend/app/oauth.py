"""OAuth 2.1 (authorization code + PKCE) against pathofexile.com.

Public-client flow per GGG's docs: PKCE is mandatory, the redirect URI must be
http://127.0.0.1:<port>/callback, access tokens last 10 hours and refresh tokens 7 days.
If OAUTH_CLIENT_SECRET is set we behave as a confidential client instead (28-day
tokens, HTTPS redirect registered with GGG).

Two ways the browser can come back:
  * The dashboard itself is reachable at the registered 127.0.0.1 URL (same machine,
    or an SSH tunnel): GGG redirects straight to /callback, which nginx forwards here.
  * The dashboard lives on another box on the LAN: tools/connect.py listens on
    127.0.0.1 on the desktop, catches the code, and posts it to /api/oauth/complete.

Tokens are stored encrypted (see secrets.py). GGG requires a specific User-Agent for
OAuth'd requests: "OAuth {client_id}/{version} (contact: {contact})".
"""
from __future__ import annotations

import base64
import hashlib
import os
import secrets as pysecrets
import time
from urllib.parse import urlencode

from . import db, gateway, secrets

CLIENT_ID = os.environ.get("OAUTH_CLIENT_ID", "").strip()
CLIENT_SECRET = os.environ.get("OAUTH_CLIENT_SECRET", "").strip()
REDIRECT_URI = os.environ.get("OAUTH_REDIRECT_URI", "http://127.0.0.1:8080/callback").strip()
SCOPES = os.environ.get("OAUTH_SCOPES", "account:profile account:characters").strip()
CONTACT = os.environ.get("OAUTH_CONTACT", "unset@example.com").strip()
VERSION = "0.1"

AUTHORIZE_URL = "https://www.pathofexile.com/oauth/authorize"
TOKEN_URL = "https://www.pathofexile.com/oauth/token"
API = "https://api.pathofexile.com"


def configured() -> bool:
    return bool(CLIENT_ID)


def user_agent() -> str:
    return f"OAuth {CLIENT_ID}/{VERSION} (contact: {CONTACT})"


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


# ------------------------------------------------------------------ flow
def start(redirect_uri: str | None = None) -> dict:
    if not configured():
        raise RuntimeError("OAUTH_CLIENT_ID is not set; register a client with GGG first")
    verifier = _b64url(os.urandom(32))
    challenge = _b64url(hashlib.sha256(verifier.encode()).digest())
    state = pysecrets.token_hex(16)
    redirect = redirect_uri or REDIRECT_URI
    pending = db.kv_get("oauth_pending", {})
    now = time.time()
    pending = {k: v for k, v in pending.items() if now - v["created"] < 600}
    pending[state] = {"verifier": verifier, "redirect_uri": redirect, "created": now}
    db.kv_set("oauth_pending", pending)
    url = AUTHORIZE_URL + "?" + urlencode({
        "client_id": CLIENT_ID, "response_type": "code", "scope": SCOPES, "state": state,
        "redirect_uri": redirect, "code_challenge": challenge, "code_challenge_method": "S256",
    })
    return {"url": url, "state": state, "redirect_uri": redirect}


async def complete(code: str, state: str) -> dict:
    pending = db.kv_get("oauth_pending", {})
    p = pending.pop(state, None)
    db.kv_set("oauth_pending", pending)
    if not p:
        raise ValueError("unknown or expired state; start the login again")
    form = {
        "client_id": CLIENT_ID, "grant_type": "authorization_code", "code": code,
        "redirect_uri": p["redirect_uri"], "scope": SCOPES, "code_verifier": p["verifier"],
    }
    if CLIENT_SECRET:
        form["client_secret"] = CLIENT_SECRET
    tok = await _token_request(form)
    _save(tok)
    return status()


async def _token_request(form: dict) -> dict:
    r = await gateway.request("POST", TOKEN_URL, policy="ggg-api", data=form, headers={"User-Agent": user_agent()})
    if r.status_code >= 400:
        try:
            err = r.json()
            raise ValueError(f"{err.get('error')}: {err.get('error_description', '')}".strip())
        except ValueError:
            raise
        except Exception:
            raise ValueError(f"token endpoint returned {r.status_code}")
    return r.json()


def _save(tok: dict) -> None:
    existing = secrets.load("oauth") or {}
    secrets.store("oauth", {
        "access_token": tok["access_token"],
        "refresh_token": tok.get("refresh_token") or existing.get("refresh_token"),
        "expires_at": time.time() + float(tok.get("expires_in") or 0),
        "refresh_expires_at": existing.get("refresh_expires_at") or (time.time() + 7 * 86400 if tok.get("refresh_token") else None),
        "username": tok.get("username"), "sub": tok.get("sub"), "scope": tok.get("scope"),
        "obtained_at": time.time(),
    })


async def token() -> str | None:
    rec = secrets.load("oauth")
    if not rec:
        return None
    if time.time() < rec["expires_at"] - 300:
        return rec["access_token"]
    if not rec.get("refresh_token"):
        return None
    form = {"client_id": CLIENT_ID, "grant_type": "refresh_token", "refresh_token": rec["refresh_token"]}
    if CLIENT_SECRET:
        form["client_secret"] = CLIENT_SECRET
    try:
        tok = await _token_request(form)
    except ValueError:
        return None
    _save(tok)
    return tok["access_token"]


def status() -> dict:
    rec = secrets.load("oauth") or {}
    return {
        "configured": configured(),
        "client_id": CLIENT_ID or None,
        "client_type": "confidential" if CLIENT_SECRET else "public",
        "redirect_uri": REDIRECT_URI,
        "scopes": SCOPES,
        "logged_in": bool(rec.get("access_token")) and time.time() < (rec.get("refresh_expires_at") or rec.get("expires_at") or 0),
        "username": rec.get("username"),
        "scope": rec.get("scope"),
        "expires_at": rec.get("expires_at"),
        "refresh_expires_at": rec.get("refresh_expires_at"),
    }


def logout() -> dict:
    secrets.clear("oauth")
    return status()


# ------------------------------------------------------------------ API calls
async def get(path: str, params: dict | None = None) -> dict:
    tok = await token()
    if not tok:
        raise PermissionError("not logged in with OAuth, or the token expired")
    r = await gateway.request("GET", f"{API}{path}", policy="ggg-api", params=params,
                              headers={"User-Agent": user_agent(), "Authorization": f"Bearer {tok}"})
    if r.status_code == 401:
        raise PermissionError("token rejected; log in again")
    if r.status_code == 403:
        raise PermissionError(f"token lacks the scope for {path}")
    r.raise_for_status()
    return r.json()
