"""arbseal.py — the owner-side opener of Arbiter feedback reports; the same envelope as
desktop/src/feedback/seal.js byte for byte (pinned by the cross-language fixtures)."""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE.parent / "bot"))
import arbseal  # noqa: E402

FIX = ROOT / "desktop" / "test" / "fixtures" / "feedback"


def keys():
    priv = X25519PrivateKey.generate()
    pub = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return priv, pub


def test_constants_match_the_js_side():
    js = (ROOT / "desktop" / "src" / "feedback" / "seal.js").read_text()
    assert arbseal.MAGIC == b"ARB1" and "const MAGIC = 'ARB1'" in js
    assert f"const KEY_ID = {arbseal.KEY_ID}" in js
    assert f"const INFO = '{arbseal.INFO.decode()}'" in js
    assert arbseal.OVERHEAD == 65


def test_round_trip_overhead_and_uniqueness():
    priv, pub = keys()
    plain = b"hello feedback " + b"x" * 1000
    a, b = arbseal.seal(plain, pub), arbseal.seal(plain, pub)
    assert len(a) == len(plain) + 65 and a[:4] == b"ARB1" and a[4] == arbseal.KEY_ID
    assert a != b
    assert arbseal.open_sealed(a, priv) == plain
    assert arbseal.open_sealed(b, priv) == plain
    assert arbseal.open_sealed(arbseal.seal(b"", pub), priv) == b""


@pytest.mark.parametrize("name,i", [("magic", 0), ("keyId", 4), ("ephPub", 12), ("nonce", 40), ("ciphertext", 51), ("tag", -1)])
def test_any_flipped_byte_fails(name, i):
    priv, pub = keys()
    sealed = bytearray(arbseal.seal(b"payload", pub))
    sealed[i] ^= 1
    with pytest.raises(Exception):
        arbseal.open_sealed(bytes(sealed), priv)


def test_wrong_key_truncation_and_bad_magic():
    priv, pub = keys()
    other, _ = keys()
    sealed = arbseal.seal(b"payload", pub)
    with pytest.raises(Exception):
        arbseal.open_sealed(sealed, other)
    with pytest.raises(arbseal.ArbError, match="ARB_TRUNCATED"):
        arbseal.open_sealed(sealed[:40], priv)
    with pytest.raises(arbseal.ArbError, match="ARB_BAD_MAGIC"):
        arbseal.open_sealed(b"NOPE" + b"x" * 80, priv)


def test_opens_a_file_sealed_by_seal_js():
    priv = serialization.load_pem_private_key((FIX / "test-key.pem").read_bytes(), password=None)
    got = arbseal.open_sealed((FIX / "sealed-by-node.arb").read_bytes(), priv)
    assert got == (FIX / "plain.txt").read_bytes()


def test_keygen_writes_a_0600_pem_and_prints_the_raw_public_key(tmp_path):
    r = subprocess.run([sys.executable, "-m", "arbseal", "keygen", "7"], cwd=tmp_path, capture_output=True, text=True,
                       env={**os.environ, "PYTHONPATH": str(HERE.parent / "bot")})
    assert r.returncode == 0, r.stderr
    pem = tmp_path / "feedback-key-7.pem"
    assert pem.exists() and (pem.stat().st_mode & 0o777) == 0o600
    pub_b64 = r.stdout.strip().splitlines()[-1]
    import base64
    assert len(base64.b64decode(pub_b64)) == 32
    # The public half is written beside the PEM too (what the build step ships).
    assert (tmp_path / "feedback-key-7.pub").read_text().strip() == pub_b64
    # The printed key seals to the written PEM.
    priv = serialization.load_pem_private_key(pem.read_bytes(), password=None)
    assert arbseal.open_sealed(arbseal.seal(b"x", base64.b64decode(pub_b64)), priv) == b"x"
    # Refuses to overwrite.
    r2 = subprocess.run([sys.executable, "-m", "arbseal", "keygen", "7"], cwd=tmp_path, capture_output=True, text=True,
                        env={**os.environ, "PYTHONPATH": str(HERE.parent / "bot")})
    assert r2.returncode != 0
