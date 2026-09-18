"""Shared fixtures: a valid report document and a helper that gzips one for the cell."""
import base64
import gzip
import io
import json
import sys
from pathlib import Path

import pytest
from hypothesis import HealthCheck, settings

# Fuzz budget: ~70 examples × 4 tests in the gate; `--hypothesis-profile=long` for a real soak.
settings.register_profile("long", max_examples=3000, deadline=None)
settings.register_profile("gate", max_examples=70, deadline=None, suppress_health_check=[HealthCheck.too_slow])
settings.load_profile("gate")

HERE = Path(__file__).resolve().parent
PKG = HERE.parent
sys.path.insert(0, str(PKG))            # `opener.*`
sys.path.insert(0, str(PKG / "bot"))    # `arbseal`, `bot`


def jpeg_bytes(w=64, h=48, color=(200, 30, 30)):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), color).save(buf, "JPEG", quality=80)
    return buf.getvalue()


def valid_doc():
    return {
        "manifest": {"v": 1, "id": "0b1a3b2c-4d5e-6f70-8192-a3b4c5d6e7f8", "ts": "2026-09-18T20:00:00.000Z",
                     "appVersion": "0.2.64", "channel": "beta", "platform": "darwin", "arch": "arm64",
                     "osRelease": "24.5.0", "electron": "33.4.11", "installId": "ab" * 16, "theme": "vault",
                     "shortId": "7F3K2Q", "screensPartial": False},
        "state": {"diag": {"time": 1, "analytics": {"jobs": [1, 2, 3]}}, "status": {"league": "Forbidden Rites"},
                  "backfill": {"running": False}, "settings": {"league": "Forbidden Rites", "reference": "exalted"},
                  "desktopSettings": {"betaChannel": True}, "bounds": {"x": 0, "y": 0, "width": 1440, "height": 847}},
        "logs": {"main": ["10:00:00 [ui] serving"], "backend": "GET /api/board 200\n", "renderer": [], "updater": ["checking"]},
        "screens": {"current": base64.b64encode(jpeg_bytes()).decode(), "board": base64.b64encode(jpeg_bytes(80, 60)).decode()},
    }


def gz(doc_or_bytes):
    raw = doc_or_bytes if isinstance(doc_or_bytes, (bytes, bytearray)) else json.dumps(doc_or_bytes).encode()
    return gzip.compress(raw)


@pytest.fixture
def report(tmp_path):
    """(in_path, out_dir) for a valid report."""
    p = tmp_path / "in.gz"
    p.write_bytes(gz(valid_doc()))
    out = tmp_path / "out"
    return p, out
