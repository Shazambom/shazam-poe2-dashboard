#!/usr/bin/env python3
"""GitHub release-webhook receiver for ShazamDash.

Verifies GitHub's HMAC signature, and on a *published* `desktop-v*` release runs the
publish script to drop the new build into /downloads — the instant equivalent of the
cron poller (ops/publish-latest.sh).

DORMANT BY DEFAULT: while the dashboard is LAN-only we rely on the cron poller and do
NOT expose this. When the site goes public, activate it (see CLAUDE.md → "Go-live:
switch to webhook"): set a secret, run it as a service, port-forward to it, and add the
webhook in the GitHub repo (Release events, same secret). Keep the poller as a fallback.

Refuses to act without a configured secret, and rejects any request whose signature
doesn't match — this endpoint triggers code, so unsigned/forged calls must do nothing.
"""
import hashlib
import hmac
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get("WEBHOOK_PORT", "9099"))
PUBLISH = os.environ.get("PUBLISH_SCRIPT", "/home/shazam/bin/poe2-publish-latest.sh")


def _secret() -> bytes | None:
    s = os.environ.get("WEBHOOK_SECRET")
    if s:
        return s.encode()
    for p in (os.path.expanduser("~/.poe2-webhook-secret"), "/home/shazam/.poe2-webhook-secret"):
        try:
            with open(p) as f:
                return f.read().strip().encode()
        except FileNotFoundError:
            pass
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % a))

    def do_GET(self):  # health check
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"poe2 webhook up")

    def do_POST(self):
        secret = _secret()
        if not secret:
            self.send_error(503, "no secret configured")
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
        expected = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(self.headers.get("X-Hub-Signature-256", ""), expected):
            self.send_error(403, "bad signature")
            return
        try:
            payload = json.loads(body or b"{}")
        except Exception:
            payload = {}
        if self.headers.get("X-GitHub-Event") == "release" and payload.get("action") in ("published", "released"):
            tag = str((payload.get("release") or {}).get("tag_name", ""))
            if tag.startswith("desktop-v"):
                subprocess.Popen(["/bin/bash", PUBLISH],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")


if __name__ == "__main__":
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
