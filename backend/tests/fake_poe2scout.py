"""A fake poe2scout (api.poe2scout.com/poe2) for simulating the league-history crawl and the seed
poll end to end: the four endpoints they call, real HTTP on 127.0.0.1, a request log, injectable
failures, and a page size small enough to force pagination.

State is per league: each item has a category, a spot price (`CurrentPrice`, what the crawl's price
floor reads) and daily rows {day: (close, average, volume)}. The listing's `PriceLogs` carry the last
seven calendar days up to `today` as (Price=average, Quantity=volume), newest first, `None` where an
item has no row, exactly as the real site does.
"""
from __future__ import annotations

import json
import threading
from collections import Counter
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse


class FakeScout:
    def __init__(self, today: str, page_size: int = 250):
        self.today = today
        self.page_size = page_size
        self.leagues: dict[str, dict] = {}           # name -> {"current": bool, "items": {id: item}}
        self.log: list[str] = []                     # every request path, in order
        self.fail: dict[str, list[int]] = {}         # path substring -> statuses to return, consumed in order
        self._lock = threading.Lock()
        self._srv = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._thread = threading.Thread(target=self._srv.serve_forever, daemon=True)

    # ------------------------------------------------------------ scenario API
    def league(self, name: str, current: bool = True) -> None:
        self.leagues.setdefault(name, {"current": current, "items": {}})["current"] = current

    def item(self, league: str, iid: int, cat: str = "currency", price: float = 10.0, name: str | None = None) -> None:
        self.leagues[league]["items"].setdefault(iid, {"cat": cat, "price": price, "name": name or f"Item {iid}", "days": {}})
        self.leagues[league]["items"][iid]["price"] = price

    def day(self, league: str, iid: int, day: str, avg: float, vol: int, close: float | None = None) -> None:
        self.leagues[league]["items"][iid]["days"][day] = (close if close is not None else avg, avg, vol)

    def drop_day(self, league: str, iid: int, day: str) -> None:
        self.leagues[league]["items"][iid]["days"].pop(day, None)

    def count(self, kind: str) -> int:
        """Requests of one kind: 'history', 'listing', 'categories', 'leagues'."""
        return Counter(_kind(p) for p in self.log)[kind]

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self._srv.server_address[1]}/poe2"

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._srv.shutdown()
        self._srv.server_close()

    # ------------------------------------------------------------ HTTP
    def _handler(self):
        scout = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                with scout._lock:
                    scout.log.append(self.path)
                    status, body = scout._route(self.path)
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                if status == 429:
                    self.send_header("Retry-After", "0")
                self.end_headers()
                self.wfile.write(data)

        return H

    def _route(self, raw: str):
        for sub, statuses in self.fail.items():
            if sub in raw and statuses:
                return statuses.pop(0), {"error": "injected"}
        u = urlparse(raw)
        parts = [unquote(p) for p in u.path.split("/") if p]
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if parts[:2] != ["poe2", "Leagues"]:
            return 404, {}
        if len(parts) == 2:
            return 200, [{"Value": n, "IsCurrent": lg["current"]} for n, lg in self.leagues.items()]
        lg = self.leagues.get(parts[2])
        if lg is None:
            return 404, {}
        rest = parts[3:]
        if rest == ["Items", "Categories"]:
            cats = sorted({it["cat"] for it in lg["items"].values()})
            return 200, {"CurrencyCategories": [{"ApiId": c} for c in cats]}
        if rest == ["Currencies", "ByCategory"]:
            return 200, self._listing(lg, q["category"], int(q.get("perPage", 250)), int(q.get("page", 1)))
        if len(rest) == 3 and rest[0] == "Items" and rest[2] == "DailyStatsHistory":
            it = lg["items"].get(int(rest[1]))
            if it is None:
                return 404, {}
            stats = [{"Time": d, "Open": c, "High": c, "Low": c, "Close": c, "Average": a, "Volume": v}
                     for d, (c, a, v) in sorted(it["days"].items())][-int(q.get("dayCount", 500)):]
            return 200, {"DailyStats": stats, "HasMore": False}
        return 404, {}

    def _listing(self, lg: dict, cat: str, per_page: int, page: int) -> dict:
        per_page = min(per_page, self.page_size)
        items = [(iid, it) for iid, it in sorted(lg["items"].items()) if it["cat"] == cat]
        pages = max(1, -(-len(items) // per_page))
        chunk = items[(page - 1) * per_page: page * per_page]
        week = [(date.fromisoformat(self.today) - timedelta(days=i)).isoformat() for i in range(7)]
        out = []
        for iid, it in chunk:
            logs = []
            for d in week:
                row = it["days"].get(d)
                logs.append({"Price": row[1], "Time": f"{d}T00:00:00.0000000Z", "Quantity": row[2]} if row else None)
            out.append({"ItemId": iid, "Text": it["name"], "ApiId": f"api-{iid}", "BaseItemTypeId": f"Meta/{iid}",
                        "CategoryApiId": cat, "CurrentPrice": it["price"], "PriceLogs": logs})
        return {"CurrentPage": page, "Pages": pages, "Total": len(items), "Items": out}


def _kind(path: str) -> str:
    if "DailyStatsHistory" in path:
        return "history"
    if "ByCategory" in path:
        return "listing"
    if "Categories" in path:
        return "categories"
    return "leagues"
