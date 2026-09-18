"""The .arb envelope, owner side — the same construction as desktop/src/feedback/seal.js:

    .arb = "ARB1"(4) | keyId(1) | ephPub(32) | nonce(12) | ciphertext | tag(16)   (65 B overhead)
    key  = HKDF-SHA256(ikm = X25519(eph, ownerPub), salt = ephPub‖ownerPub, info = INFO, 32)
    AAD  = the 5 header bytes

`open_sealed` is what the bot runs (pure math, no parsing: a bad tag stops here). `seal` exists for
the tests and the cross-language fixture. `python -m arbseal keygen <keyId>` mints the owner
keypair: the PEM stays on shazam (0600, never committed); the printed base64 goes into seal.js.
"""
from __future__ import annotations

import base64
import os
import sys

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

MAGIC = b"ARB1"
KEY_ID = 1
INFO = b"arbiter-feedback-v1"
OVERHEAD = 4 + 1 + 32 + 12 + 16


class ArbError(ValueError):
    pass


def _raw_pub(key: X25519PublicKey) -> bytes:
    return key.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def _derive(priv: X25519PrivateKey, pub: X25519PublicKey, eph_pub: bytes, owner_pub: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=eph_pub + owner_pub, info=INFO).derive(priv.exchange(pub))


def seal(plain: bytes, owner_pub: bytes, key_id: int = KEY_ID) -> bytes:
    if len(owner_pub) != 32:
        raise ArbError("ARB_BAD_PUBKEY")
    eph = X25519PrivateKey.generate()
    eph_pub = _raw_pub(eph.public_key())
    key = _derive(eph, X25519PublicKey.from_public_bytes(owner_pub), eph_pub, owner_pub)
    nonce = os.urandom(12)
    header = MAGIC + bytes([key_id])
    return header + eph_pub + nonce + AESGCM(key).encrypt(nonce, plain, header)


def open_sealed(data: bytes, private_key: X25519PrivateKey) -> bytes:
    if len(data) < OVERHEAD:
        raise ArbError("ARB_TRUNCATED")
    if data[:4] != MAGIC:
        raise ArbError("ARB_BAD_MAGIC")
    header, eph_pub, nonce, body = data[:5], data[5:37], data[37:49], data[49:]
    owner_pub = _raw_pub(private_key.public_key())
    key = _derive(private_key, X25519PublicKey.from_public_bytes(eph_pub), eph_pub, owner_pub)
    return AESGCM(key).decrypt(nonce, body, header)   # InvalidTag on any tampering


def keygen(key_id: int) -> str:
    """Write feedback-key-<keyId>.pem (0600, never overwritten) and feedback-key-<keyId>.pub; return
    the raw public key as base64."""
    path = f"feedback-key-{key_id}.pem"
    priv = X25519PrivateKey.generate()
    pem = priv.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)   # O_EXCL: refuse to overwrite
    with os.fdopen(fd, "wb") as f:
        f.write(pem)
    pub = base64.b64encode(_raw_pub(priv.public_key())).decode()
    with open(f"feedback-key-{key_id}.pub", "w") as f:   # the public half: what the app ships
        f.write(pub + "\n")
    return pub


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "keygen":
        print(keygen(int(sys.argv[2])))
    else:
        sys.exit("usage: python -m arbseal keygen <keyId>")
