"""Single outbound HTTP gateway with per-host rate policies.

Every request the backend makes goes through `request()`. Each policy owns a
pyrate-limiter `Limiter` (sliding window, multiple rates) that starts conservative and
is re-derived from GGG's `X-Rate-Limit-*` headers after every response, scaled by a
safety factor so we never approach the real ceiling. 429s (or a state header showing
the window nearly spent) put the policy in a penalty box that all callers wait on.

GGG header format (per rule in X-Rate-Limit-Rules, e.g. "Ip,Account"):
  X-Rate-Limit-Ip:        12:6:60,16:12:120     -> hits:window_s:penalty_s, ...
  X-Rate-Limit-Ip-State:  3:6:0,4:12:0          -> hits_so_far:window_s:penalty_active
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from urllib.parse import urlparse

import httpx
from pyrate_limiter import Duration, Limiter, Rate

from .config import USER_AGENT

log = logging.getLogger(__name__)

SAFETY = 0.5          # use at most half of any advertised window
STATE_HOLD = 0.8      # if a window is >80% spent, hold until it rolls
DEFAULT_TIMEOUT = 30


class RateLimited(Exception):
    def __init__(self, retry_after: float, policy: str):
        super().__init__(f"{policy}: rate limited, retry after {retry_after:.0f}s")
        self.retry_after = retry_after


@dataclass
class Policy:
    name: str
    rates: list[Rate]
    hosts: tuple[str, ...]
    limiter: Limiter = field(init=False)
    penalty_until: float = 0.0
    last_headers: dict = field(default_factory=dict)
    requests: int = 0
    throttled: int = 0
    advertised: list[tuple[int, int, int]] = field(default_factory=list)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def __post_init__(self) -> None:
        self.limiter = Limiter(self.rates)

    # ---------------------------------------------------------- waiting
    async def acquire(self, timeout: float = 120) -> None:
        while True:
            hold = self.penalty_until - time.time()
            if hold <= 0:
                break
            await asyncio.sleep(min(hold, 5))
        ok = await self.limiter.try_acquire_async(self.name, blocking=True, timeout=timeout)
        if not ok:
            raise RateLimited(timeout, self.name)
        self.requests += 1

    def penalize(self, seconds: float, why: str) -> None:
        self.penalty_until = max(self.penalty_until, time.time() + seconds)
        self.throttled += 1
        log.warning("%s: holding %.0fs (%s)", self.name, seconds, why)

    def try_acquire_now(self) -> float:
        """Non-blocking reservation for an out-of-process caller (the Electron live-search engine):
        0.0 when a slot was taken, else the seconds to wait. Never sleeps — request threads stay
        snappy; the caller decides whether to retry."""
        hold = self.penalty_until - time.time()
        if hold > 0:
            return hold
        if not self.limiter.try_acquire(self.name, blocking=False):
            win = max((r.interval for r in self.rates), default=1000) / 1000.0
            return max(1.0, min(win, 30.0))
        self.requests += 1
        return 0.0

    def hint(self) -> None:
        """A request made by ANOTHER process on the same account/IP (an EE2 price check) just spent a
        slot: consume one from our view if there is one, never penalise, never block."""
        self.limiter.try_acquire(self.name, blocking=False)
        self.requests += 1

    # ---------------------------------------------------------- adapting
    def observe(self, resp: httpx.Response) -> None:
        self.observe_headers(resp.status_code, dict(resp.headers.items()))

    def observe_headers(self, status_code: int, headers: dict) -> None:
        """Reconcile to the server's X-Rate-Limit-* view. Also the entry point for headers
        observed by another process against the same budget (Electron → /api/ratelimits/observe)."""
        h = {k.lower(): v for k, v in headers.items() if k.lower().startswith("x-rate-limit") or k.lower() == "retry-after"}
        if h:
            self.last_headers = h
        if status_code == 429:
            self.penalize(float(h.get("retry-after", 60)) + 1, "429")
            return
        rules = [r.strip().lower() for r in h.get("x-rate-limit-rules", "").split(",") if r.strip()]
        if not rules:
            return
        advertised: list[tuple[int, int, int]] = []
        hold = 0.0
        for rule in rules:
            limits = _triples(h.get(f"x-rate-limit-{rule}", ""))
            states = _triples(h.get(f"x-rate-limit-{rule}-state", ""))
            advertised += limits
            for (lim, win, pen), st in zip(limits, states + [(0, 0, 0)] * len(limits)):
                hits, _, pen_active = st
                if pen_active:
                    hold = max(hold, pen_active)
                elif lim and hits >= max(1, int(lim * STATE_HOLD)):
                    hold = max(hold, min(win, 30))
        if hold:
            self.penalize(hold, "window nearly spent")
        if advertised and advertised != self.advertised:
            self.advertised = advertised
            self.rates = [Rate(max(1, int(lim * SAFETY)), Duration.SECOND * win) for lim, win, _ in advertised]
            self.limiter = Limiter(self.rates)
            log.info("%s: rates now %s", self.name, [(r.limit, r.interval // 1000) for r in self.rates])

    def to_json(self) -> dict:
        return {
            "name": self.name,
            "rates": [{"limit": r.limit, "window_s": r.interval // 1000} for r in self.rates],
            "advertised": [{"limit": l, "window_s": w, "penalty_s": p} for l, w, p in self.advertised],
            "penalty_remaining_s": max(0.0, self.penalty_until - time.time()),
            "requests": self.requests,
            "throttled": self.throttled,
            "state": self.last_headers.get("x-rate-limit-ip-state") or self.last_headers.get("x-rate-limit-account-state"),
        }


def _triples(s: str) -> list[tuple[int, int, int]]:
    out = []
    for part in s.split(","):
        bits = part.strip().split(":")
        if len(bits) == 3 and all(b.isdigit() for b in bits):
            out.append((int(bits[0]), int(bits[1]), int(bits[2])))
    return out


POLICIES: dict[str, Policy] = {p.name: p for p in [
    # Trade-site exchange: undocumented, the strictest. Start at 1 per 6 s / 8 per minute.
    Policy("trade", [Rate(1, Duration.SECOND * 6), Rate(8, Duration.MINUTE)], ("www.pathofexile.com",)),
    # Trade-site listing fetch + whisper, driven by the Electron live-search engine through
    # /api/ratelimits (same host, separate GGG rules; reached by override only — host lookup
    # resolves to "trade" above). Conservative starts; re-derived from headers like the rest.
    Policy("trade-fetch", [Rate(1, Duration.SECOND), Rate(20, Duration.MINUTE)], ("www.pathofexile.com",)),
    Policy("trade-whisper", [Rate(1, Duration.SECOND * 2), Rate(10, Duration.MINUTE)], ("www.pathofexile.com",)),
    # Merchant History (/api/trade2/history) for the Sales tab: 5 quick GETs produced a 429 in research,
    # so start very conservative; headers refine it. Polled at most every 10 min while the tab is visible.
    Policy("trade-history", [Rate(1, Duration.SECOND * 10), Rate(4, Duration.MINUTE)], ("www.pathofexile.com",)),
    # OAuth'd account API and token endpoint.
    Policy("ggg-api", [Rate(1, Duration.SECOND * 2), Rate(20, Duration.MINUTE)], ("api.pathofexile.com",)),
    # Public hourly digest CDN: no headers. Quick enough that a week's backfill
    # lands in a few minutes, still far below anything a CDN would notice.
    Policy("digest", [Rate(1, Duration.SECOND), Rate(30, Duration.MINUTE)], ("web.poecdn.com",)),
    # Static/community mirrors.
    Policy("static", [Rate(1, Duration.SECOND), Rate(30, Duration.MINUTE)], ("ggpk.exposed", "github.com", "objects.githubusercontent.com")),
    # poe2scout economy history — no auth, Cloudflare-fronted; be polite.
    Policy("poe2scout", [Rate(1, Duration.SECOND), Rate(20, Duration.MINUTE)], ("api.poe2scout.com",)),
]}


def policy_for(url: str, override: str | None = None) -> Policy:
    if override:
        return POLICIES[override]
    host = urlparse(url).hostname or ""
    for p in POLICIES.values():
        if host in p.hosts:
            return p
    return POLICIES["static"]


_client: httpx.AsyncClient | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, headers={"User-Agent": USER_AGENT}, follow_redirects=True)
    return _client


async def request(method: str, url: str, *, policy: str | None = None, retries: int = 2, **kw) -> httpx.Response:
    """Rate-limited request. Waits for the policy's window, adapts to headers, and
    retries once after a 429 penalty. Raises RateLimited if it can't get a slot."""
    p = policy_for(url, policy)
    for attempt in range(retries + 1):
        await p.acquire()
        resp = await client().request(method, url, **kw)
        p.observe(resp)
        if resp.status_code != 429:
            return resp
        if attempt == retries:
            raise RateLimited(max(1.0, p.penalty_until - time.time()), p.name)
    raise RateLimited(60, p.name)  # unreachable


def status() -> dict:
    return {k: v.to_json() for k, v in POLICIES.items()}
