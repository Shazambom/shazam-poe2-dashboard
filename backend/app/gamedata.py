"""Pull the exchange gold fees straight from the game's data tables.

GGG stores the Currency Exchange fee per item in Data/CurrencyExchange.datc64
(column GoldPurchaseFee, i32) keyed by a BaseItemTypes row. ggpk.exposed serves the
current patch's raw files over HTTP, and the community schema
(poe-tool-dev/dat-schema) tells us the column layout, so we can build
{metadata_id: gold_fee} with no game client and no hand entry.

datc64 layout: u32 row_count, fixed-width rows, 8 bytes of 0xBB, then the variable
section. Strings are UTF-16LE terminated by four zero bytes; string/array fields hold
a u64 offset relative to the start of the variable section (the 0xBB marker).
64-bit foreign-row refs are 16 bytes (row index + padding); 0xFE.. means null.
"""
from __future__ import annotations

import json
import logging
import struct
import time

from . import db, gateway
from .config import DATA_DIR

log = logging.getLogger(__name__)

GGPK = "https://ggpk.exposed"
# ggpk.exposed became a VueFinder SPA and the tables moved to data/balance/;
# the old /poe2/data/<file> paths 302 to an HTML viewer page.
GGPK_FILE = GGPK + "/files?q=download&adapter=poe2&path=poe2://data/balance/{name}"
SCHEMA_URL = "https://github.com/poe-tool-dev/dat-schema/releases/download/latest/schema.min.json"
MAGIC = b"\xbb" * 8
NULL_ROW = 0xFEFEFEFEFEFEFEFE
CACHE = DATA_DIR / "gamedata"
CACHE.mkdir(parents=True, exist_ok=True)

SIZES = {"bool": 1, "i16": 2, "u16": 2, "i32": 4, "u32": 4, "f32": 4, "i64": 8, "u64": 8,
         "string": 8, "foreignrow": 16, "row": 8, "enumrow": 4, "array": 16}

state = {"loaded_at": None, "version": None, "rows": 0, "last_error": None, "source": None}


# ------------------------------------------------------------------ parsing
class Dat:
    def __init__(self, raw: bytes):
        self.count = struct.unpack_from("<I", raw, 0)[0]
        self.data_start = raw.find(MAGIC)
        if self.data_start < 0:
            raise ValueError("no variable-section marker; not a datc64 file?")
        self.row_width = (self.data_start - 4) // self.count if self.count else 0
        self.raw = raw

    def row(self, i: int) -> bytes:
        off = 4 + i * self.row_width
        return self.raw[off: off + self.row_width]

    def string(self, offset: int) -> str:
        p = self.data_start + offset
        end = p
        while end + 1 < len(self.raw):
            if self.raw[end] == 0 and self.raw[end + 1] == 0:
                break
            end += 2
        return self.raw[p:end].decode("utf-16-le", errors="replace")


def column_offsets(columns: list[dict]) -> dict[str, tuple[int, str]]:
    """{name: (offset, type)} for named columns; unnamed ones still take space."""
    out, off = {}, 0
    for i, c in enumerate(columns):
        t = "array" if c.get("array") else c["type"]
        if c.get("name"):
            out[c["name"]] = (off, t)
        out[f"_{i}"] = (off, t)
        off += SIZES[t]
    return out


def read(dat: Dat, r: bytes, off: int, t: str):
    if t == "bool":
        return bool(r[off])
    if t in ("i32", "enumrow"):
        return struct.unpack_from("<i", r, off)[0]
    if t == "u32":
        return struct.unpack_from("<I", r, off)[0]
    if t == "f32":
        return struct.unpack_from("<f", r, off)[0]
    if t in ("i16", "u16"):
        return struct.unpack_from("<h" if t == "i16" else "<H", r, off)[0]
    if t == "string":
        return dat.string(struct.unpack_from("<Q", r, off)[0])
    if t in ("foreignrow", "row"):
        v = struct.unpack_from("<Q", r, off)[0]
        return None if v == NULL_ROW else v
    return None


# ------------------------------------------------------------------ fetching
async def _get(url: str, name: str, max_age_s: int) -> bytes:
    path = CACHE / name
    if path.exists() and time.time() - path.stat().st_mtime < max_age_s:
        return path.read_bytes()
    r = await gateway.request("GET", url, policy="static")
    r.raise_for_status()
    if r.content[:1] == b"<":   # HTML error/viewer page — never cache it as data
        raise ValueError(f"{name}: got HTML instead of a data file (URL layout changed?)")
    path.write_bytes(r.content)
    return r.content


async def refresh(force: bool = False) -> dict:
    """Download tables, parse, and store {trade_id/metadata_id: fee} in kv."""
    max_age = 0 if force else 86400
    try:
        version = None
        try:
            v = await gateway.request("GET", f"{GGPK}/version?poe=2", policy="static")
            version = v.text.strip()[:40] if v.status_code == 200 else None
        except Exception:
            pass
        if version and version != state.get("version"):
            max_age = 0
        schema = json.loads(await _get(SCHEMA_URL, "schema.min.json", 7 * 86400))
        ce_raw = await _get(GGPK_FILE.format(name="currencyexchange.datc64"), "currencyexchange.datc64", max_age)
        bit_raw = await _get(GGPK_FILE.format(name="baseitemtypes.datc64"), "baseitemtypes.datc64", max_age)
        cat_raw = await _get(GGPK_FILE.format(name="currencyexchangecategories.datc64"),
                             "currencyexchangecategories.datc64", max_age)
    except Exception as exc:
        state["last_error"] = str(exc)
        log.warning("gold fee refresh failed: %s", exc)
        return fees()

    def table(name: str, valid_for: int) -> list[dict]:
        for t in schema["tables"]:
            if t["name"] == name and t["validFor"] in (valid_for, 3):
                return t["columns"]
        raise KeyError(name)

    ce = Dat(ce_raw)
    cols = column_offsets(table("CurrencyExchange", 2))
    expected = sum(SIZES["array" if c.get("array") else c["type"]] for c in table("CurrencyExchange", 2))
    if expected != ce.row_width:
        log.warning("CurrencyExchange row width %d != schema %d; parsing may be off", ce.row_width, expected)

    bit = Dat(bit_raw)  # BaseItemTypes: column 0 is Id (string) in both games
    cats = Dat(cat_raw)
    cat_cols = column_offsets(table("CurrencyExchangeCategories", 3))

    def base_id(idx: int | None) -> str | None:
        if idx is None or idx >= bit.count:
            return None
        return read(bit, bit.row(idx), 0, "string")

    def cat_name(idx: int | None) -> str | None:
        if idx is None or idx >= cats.count:
            return None
        o, t = cat_cols.get("Name", cat_cols.get("_1"))
        return read(cats, cats.row(idx), o, t)

    by_meta: dict[str, dict] = {}
    for i in range(ce.count):
        r = ce.row(i)
        item = read(ce, r, *cols["Item"])
        meta = base_id(item)
        if not meta:
            continue
        by_meta[meta] = {
            "fee": read(ce, r, *cols["GoldPurchaseFee"]),
            "category": cat_name(read(ce, r, *cols["Category"])),
            "subcategory": cat_name(read(ce, r, *cols["SubCategory"])),
            "standard": read(ce, r, *cols["EnabledInStandardLeague"]),
            "challenge": read(ce, r, *cols["EnabledInChallengeLeague"]),
        }

    db.kv_set("gold_fees_meta", by_meta)
    state.update(loaded_at=time.time(), version=version, rows=len(by_meta), last_error=None, source="ggpk.exposed")
    log.info("loaded %d exchange gold fees (patch %s)", len(by_meta), version)
    return fees()


# ------------------------------------------------------------------ queries
def fees() -> dict:
    """Fees keyed by trade id (where mapped) plus the raw metadata-keyed table."""
    from .currencies import registry

    by_meta = db.kv_get("gold_fees_meta", {})
    by_trade: dict[str, int] = {}
    unmapped = []
    for meta, e in by_meta.items():
        tid = registry.resolve_meta(meta)
        if tid:
            by_trade[tid] = e["fee"]
        else:
            unmapped.append(meta)
    return {"by_trade": by_trade, "by_meta": by_meta, "unmapped": sorted(unmapped), "state": state}
