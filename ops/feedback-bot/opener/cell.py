"""The opener cell: turns one decrypted report (gzip bytes) into a folder of files, assuming the
bytes are hostile. Runs as a throwaway child process under rlimits, in a container with no
network, no token and no key (see opener.py). Hard stops, in order:

  1. decompress under a ceiling (a zip bomb stops at MAX_PLAIN)
  2. json.loads rejecting duplicate keys, depth > MAX_DEPTH, > MAX_KEYS keys
  3. REBUILD, don't pass through: a new document is built from the schema below; there is no code
     path that copies an undeclared key. Missing required field / uncoercible type → QUARANTINE.
  4. screens: name must be in dests.SCREENS; bytes ≤ MAX_SCREEN_BYTES, JPEG magic, decoded by
     Pillow under MAX_PIXELS, forced RGB, RE-ENCODED — what leaves is pixels we produced
  5. output paths come from the schema only, every one resolved under outdir
  6. imports: zlib, json, html, pathlib, PIL and nothing else (pinned by a test)

Exit codes: 0 OK, 2 QUARANTINE (the file is not a report we can read); anything else is a crash,
which the supervisor reports as REFUSE.
"""
from __future__ import annotations

import base64
import html
import io
import json
import re
import sys
import zlib
from pathlib import Path

from PIL import Image

from .dests import SCREENS

MAX_PLAIN = 32 * 1024 * 1024
MAX_DEPTH = 32
MAX_KEYS = 10_000
MAX_STR = 2000            # any string inside state
MAX_STATE_DEPTH = 8
MAX_STATE_NODES = 20_000
MAX_LOG_LINES = 400
MAX_LOG_LINE = 1024
MAX_SCREEN_BYTES = 2 * 1024 * 1024
MAX_PIXELS = 4_000_000
SHORT_ID = re.compile(r"^[0-9A-HJ-NP-Z]{6}$")
JPEG_MAGIC = b"\xff\xd8\xff"
OK, QUARANTINE = 0, 2

Image.MAX_IMAGE_PIXELS = MAX_PIXELS


class Refused(Exception):
    pass


# ---------------------------------------------------------------- 1. decompress
def decompress_capped(data: bytes, limit: int) -> bytes:
    d = zlib.decompressobj(16 + zlib.MAX_WBITS)   # gzip
    out = bytearray()
    view = memoryview(data)
    pos = 0
    while pos < len(view) or d.unconsumed_tail:
        chunk = d.unconsumed_tail if d.unconsumed_tail else view[pos:pos + 65536]
        if not d.unconsumed_tail:
            pos += 65536
        out += d.decompress(chunk, limit - len(out) + 1)
        if len(out) > limit:
            raise Refused("too large")
    return bytes(out)


# ---------------------------------------------------------------- 2. parse
def parse_json(text: bytes):
    count = 0

    def pairs(items):
        nonlocal count
        keys = [k for k, _ in items]
        if len(keys) != len(set(keys)):
            raise Refused("duplicate key")
        count += len(keys)
        if count > MAX_KEYS:
            raise Refused("too many keys")
        return dict(items)

    if _depth(text) > MAX_DEPTH:
        raise Refused("too deep")
    try:
        doc = json.loads(text, object_pairs_hook=pairs)
    except (ValueError, RecursionError) as e:
        raise Refused(f"bad json: {e.__class__.__name__}")
    if not isinstance(doc, dict):
        raise Refused("not an object")
    return doc


def _depth(text: bytes) -> int:
    """Bracket depth of a JSON text, ignoring brackets inside strings (a cheap pre-check so the
    recursive parser never sees pathological nesting)."""
    depth = best = 0
    in_str = esc = False
    for b in text:
        if in_str:
            if esc:
                esc = False
            elif b == 0x5C:
                esc = True
            elif b == 0x22:
                in_str = False
        elif b == 0x22:
            in_str = True
        elif b in (0x7B, 0x5B):
            depth += 1
            if depth > best:
                best = depth
                if best > MAX_DEPTH:
                    return best
        elif b in (0x7D, 0x5D):
            depth -= 1
    return best


# ---------------------------------------------------------------- 3. rebuild
def _str(v, n=MAX_STR, required=False):
    if v is None and not required:
        return None
    if not isinstance(v, str):
        raise Refused("not a string")
    return v[:n]


def _int(v, lo, hi):
    if isinstance(v, bool) or not isinstance(v, int) or not (lo <= v <= hi):
        raise Refused("bad int")
    return v


def _bool(v):
    if not isinstance(v, bool):
        raise Refused("bad bool")
    return v


def _bounded(v, depth=0, budget=None):
    """A fresh, bounded copy of free-form JSON: strings capped, depth and node count limited.
    Anything past the ceiling is cut, never copied."""
    if budget is None:
        budget = [MAX_STATE_NODES]
    budget[0] -= 1
    if budget[0] < 0 or depth > MAX_STATE_DEPTH:
        return None
    if v is None or isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v if -2**53 <= v <= 2**53 else None
    if isinstance(v, float):
        return v if v == v and abs(v) != float("inf") else None
    if isinstance(v, str):
        return v[:MAX_STR]
    if isinstance(v, list):
        return [_bounded(x, depth + 1, budget) for x in v[:1000]]
    if isinstance(v, dict):
        return {str(k)[:200]: _bounded(x, depth + 1, budget) for k, x in list(v.items())[:1000]}
    return None


def _lines(v):
    if not isinstance(v, list):
        raise Refused("log not a list")
    return [str(x)[:MAX_LOG_LINE] if isinstance(x, str) else "" for x in v[-MAX_LOG_LINES:]]


def _text(v):
    if not isinstance(v, str):
        raise Refused("log not a string")
    return _lines(v.splitlines()[-MAX_LOG_LINES:])


def rebuild(doc: dict) -> dict:
    m = doc.get("manifest")
    s = doc.get("state")
    l = doc.get("logs")
    if not isinstance(m, dict) or not isinstance(s, dict) or not isinstance(l, dict):
        raise Refused("missing section")
    short_id = _str(m.get("shortId"), 6, required=True)
    if not SHORT_ID.match(short_id or ""):
        raise Refused("bad shortId")
    manifest = {
        "v": _int(m.get("v"), 1, 1),
        "id": _str(m.get("id"), 64), "ts": _str(m.get("ts"), 40), "appVersion": _str(m.get("appVersion"), 32),
        "channel": _str(m.get("channel"), 16), "platform": _str(m.get("platform"), 16), "arch": _str(m.get("arch"), 16),
        "osRelease": _str(m.get("osRelease"), 64), "electron": _str(m.get("electron"), 32),
        "installId": _str(m.get("installId"), 64), "theme": _str(m.get("theme"), 64), "shortId": short_id,
        "screensPartial": _bool(m.get("screensPartial", False)),
    }
    state = {k: _bounded(s.get(k)) for k in ("diag", "status", "backfill", "settings", "desktopSettings", "bounds")}
    logs = {"main": _lines(l.get("main", [])), "backend": _text(l.get("backend", "")),
            "renderer": _lines(l.get("renderer", [])), "updater": _lines(l.get("updater", []))}
    return {"manifest": manifest, "state": state, "logs": logs}


# ---------------------------------------------------------------- 4. screens
def reencode(b64) -> bytes | None:
    """Base64 → bytes → JPEG magic → decoded under MAX_PIXELS → RGB → a fresh JPEG. None = drop."""
    try:
        if not isinstance(b64, str) or len(b64) > MAX_SCREEN_BYTES * 4 // 3 + 4:
            return None
        raw = base64.b64decode(b64, validate=True)
        if len(raw) > MAX_SCREEN_BYTES or raw[:3] != JPEG_MAGIC:
            return None
        im = Image.open(io.BytesIO(raw))
        im.load()
        im = im.convert("RGB")
        out = io.BytesIO()
        im.save(out, "JPEG", quality=75)
        return out.getvalue()
    except Exception:
        return None


def screens_of(doc: dict) -> list[tuple[int, str, bytes]]:
    sc = doc.get("screens")
    if not isinstance(sc, dict):
        return []
    out = []
    for i, name in enumerate(SCREENS):        # order and names from the schema, never the report
        if name in sc:
            data = reencode(sc[name])
            if data:
                out.append((i, name, data))
    return out


# ---------------------------------------------------------------- 5. write
def _under(outdir: Path, rel: str) -> Path:
    p = (outdir / rel).resolve()
    if outdir.resolve() not in p.parents:
        raise Refused("path escape")
    return p


def write_out(rebuilt: dict, screens: list[tuple[int, str, bytes]], outdir: Path) -> None:
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "logs").mkdir(exist_ok=True)
    if screens:
        (outdir / "screens").mkdir(exist_ok=True)
    names = {}
    for i, name, data in screens:
        rel = f"screens/{i:02d}-{name}.jpg"
        _under(outdir, rel).write_bytes(data)
        names[name] = rel
    for k in ("main", "backend", "renderer", "updater"):
        _under(outdir, f"logs/{k}.txt").write_text("".join(line + "\n" for line in rebuilt["logs"][k]))
    report = {"manifest": rebuilt["manifest"], "state": rebuilt["state"], "logs": {k: f"logs/{k}.txt" for k in rebuilt["logs"]},
              "screens": names}
    _under(outdir, "report.json").write_text(json.dumps(report, indent=1))
    _under(outdir, "index.html").write_text(render_html(rebuilt, names))


def render_html(rebuilt: dict, names: dict) -> str:
    e = html.escape
    m = rebuilt["manifest"]
    head = " · ".join(e(str(m.get(k) or "")) for k in ("shortId", "appVersion", "channel", "platform", "arch", "theme", "ts"))
    parts = ["<!doctype html><html><head><meta charset=\"utf-8\">",
             "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'\">",
             f"<title>Arbiter report {e(m['shortId'])}</title>",
             "<style>body{font:13px/1.4 system-ui;margin:20px;background:#15171c;color:#ddd}img{max-width:100%;border:1px solid #444;margin:6px 0}pre{white-space:pre-wrap;background:#0e0f12;padding:8px;max-height:400px;overflow:auto}h2{margin-top:28px}</style>",
             f"</head><body><h1>Arbiter report</h1><p>{head}</p>"]
    for name, rel in names.items():
        parts.append(f"<h2>{e(name)}</h2><img src=\"{e(rel)}\" alt=\"{e(name)}\">")
    for k in ("main", "backend", "renderer", "updater"):
        parts.append(f"<h2>log: {k}</h2><pre>{e(chr(10).join(rebuilt['logs'][k]))}</pre>")
    parts.append(f"<h2>state</h2><pre>{e(json.dumps(rebuilt['state'], indent=1))}</pre></body></html>")
    return "".join(parts)


# ---------------------------------------------------------------- entry
def run(in_path: Path, outdir: Path) -> int:
    try:
        plain = decompress_capped(Path(in_path).read_bytes(), MAX_PLAIN)
        doc = parse_json(plain)
        rebuilt = rebuild(doc)
        shots = screens_of(doc)
        write_out(rebuilt, shots, Path(outdir))
        return OK
    except (Refused, zlib.error, UnicodeDecodeError):
        return QUARANTINE


if __name__ == "__main__":
    sys.exit(run(Path(sys.argv[1]), Path(sys.argv[2])))
