#!/usr/bin/env python3
"""Connect your PoE account to the dashboard from the PC you play on.

  python connect.py --server http://192.168.1.50:8080 session     # push POESESSID
  python connect.py --server http://192.168.1.50:8080 oauth       # log in with OAuth
  python connect.py --server http://192.168.1.50:8080 both

`session` reads the POESESSID cookie straight out of your browser's cookie store
(needs `pip install browser-cookie3`; log in on pathofexile.com first) and sends it to
the dashboard, which verifies it against the exchange and stores it encrypted. If the
cookie can't be read automatically you'll be prompted to paste it.

`oauth` asks the dashboard for a login URL, opens it in your browser, catches GGG's
redirect on 127.0.0.1 (the address a public client must use), and hands the code back
to the dashboard, which exchanges it with its PKCE verifier. Nothing secret touches this
script.
"""
from __future__ import annotations

import argparse
import getpass
import http.server
import json
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser


def call(server: str, path: str, method: str = "GET", body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(server.rstrip("/") + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("detail", "")
        except Exception:
            detail = ""
        sys.exit(f"dashboard returned {e.code}: {detail}")


def read_cookie(browser: str) -> str | None:
    try:
        import browser_cookie3 as bc
    except ImportError:
        print("browser-cookie3 not installed (pip install browser-cookie3); falling back to paste.")
        return None
    loaders = {"chrome": bc.chrome, "firefox": bc.firefox, "edge": bc.edge, "brave": bc.brave, "opera": bc.opera}
    order = [browser] if browser != "auto" else list(loaders)
    for name in order:
        try:
            jar = loaders[name](domain_name="pathofexile.com")
        except Exception as exc:
            if browser != "auto":
                print(f"{name}: {exc}")
            continue
        for c in jar:
            if c.name == "POESESSID" and c.value:
                print(f"found POESESSID in {name}")
                return c.value
    return None


def do_session(server: str, browser: str) -> None:
    cookie = read_cookie(browser)
    if not cookie:
        print("Paste POESESSID (devtools -> Application/Storage -> Cookies -> pathofexile.com):")
        cookie = getpass.getpass("POESESSID: ").strip()
    res = call(server, "/api/session", "POST", {"cookie": cookie, "label": f"connect.py ({browser})"})
    print(res.get("message", "connected"))


def do_oauth(server: str) -> None:
    start = call(server, "/api/oauth/start", "POST", {})
    redirect = urllib.parse.urlparse(start["redirect_uri"])
    host, port, path = redirect.hostname or "127.0.0.1", redirect.port or 80, redirect.path or "/callback"
    done = threading.Event()
    result: dict = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            if u.path != path:
                self.send_error(404)
                return
            q = urllib.parse.parse_qs(u.query)
            result.update({k: v[0] for k, v in q.items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(b"<p style='font-family:sans-serif'>Logged in. You can close this tab.</p>")
            done.set()

    try:
        srv = http.server.HTTPServer((host, port), Handler)
    except OSError as exc:
        sys.exit(f"could not listen on {host}:{port} ({exc}); the registered redirect port must be free")
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f"listening on {host}:{port}{path}; opening browser")
    webbrowser.open(start["url"])
    print("if the browser didn't open, visit:\n  " + start["url"])
    if not done.wait(300):
        sys.exit("timed out waiting for the login redirect")
    srv.shutdown()
    if "error" in result:
        sys.exit(f"login failed: {result.get('error_description') or result['error']}")
    # Authorization codes expire in 30 s, so hand it over immediately.
    res = call(server, "/api/oauth/complete", "POST", {"code": result["code"], "state": result["state"]})
    print(f"logged in as {res.get('username')} with scope '{res.get('scope')}'")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", required=True, help="dashboard URL, e.g. http://192.168.1.50:8080")
    ap.add_argument("--browser", default="auto", choices=["auto", "chrome", "firefox", "edge", "brave", "opera"])
    ap.add_argument("what", choices=["session", "oauth", "both"])
    a = ap.parse_args()
    if a.what in ("session", "both"):
        do_session(a.server, a.browser)
    if a.what in ("oauth", "both"):
        do_oauth(a.server)


if __name__ == "__main__":
    main()
