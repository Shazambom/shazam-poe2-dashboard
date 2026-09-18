// The .arb envelope: a feedback report sealed to the OWNER's public key so only the owner can read
// it — X25519 (ephemeral → owner) → HKDF-SHA256 → AES-256-GCM, Node built-ins only. The app holds
// only the public key; the private key lives on shazam (ops/feedback-bot/arbseal.py is the real
// opener — the same construction byte for byte). `open()` here is for the tests.
//
//   .arb = "ARB1"(4) | keyId(1) | ephPub(32) | nonce(12) | ciphertext | tag(16)   (65 B overhead)
//   key  = HKDF-SHA256(ikm = X25519(eph, ownerPub), salt = ephPub‖ownerPub, info = INFO, 32)
//   AAD  = the 5 header bytes — a header edit fails the tag
'use strict'
const crypto = require('crypto')

const MAGIC = 'ARB1'
const KEY_ID = 1                     // bump on owner-key rotation (the old PEM stays readable on shazam)
const INFO = 'arbiter-feedback-v1'
// The owner's X25519 public key (raw 32 bytes, base64): the public half of the keypair shazam minted
// with `python -m arbseal keygen 1` (the private half never leaves /etc/arbiter/keys there). It ships
// as a file beside this module so a rotation is a file copy, not a code edit.
const OWNER_PUB_B64 = require('fs').readFileSync(require('path').join(__dirname, 'owner-key.pub'), 'utf8').trim()
const OVERHEAD = 4 + 1 + 32 + 12 + 16
// Raw 32-byte X25519 public keys import through the fixed SPKI prefix (verified on Node 18).
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

const rawPub = (b64) => {
  const raw = Buffer.from(b64, 'base64')
  if (raw.length !== 32) throw new Error('ARB_BAD_PUBKEY')
  return raw
}
const importPub = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' })
const exportRawPub = (keyObject) => { const der = keyObject.export({ type: 'spki', format: 'der' }); return der.subarray(der.length - 32) }

function deriveKey(privateKey, publicKey, ephPub, ownerPub) {
  const ikm = crypto.diffieHellman({ privateKey, publicKey })
  return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.concat([ephPub, ownerPub]), INFO, 32))   // hkdfSync → ArrayBuffer
}

function seal(plain, ownerPubB64 = OWNER_PUB_B64, keyId = KEY_ID) {
  const ownerPub = rawPub(ownerPubB64)
  const eph = crypto.generateKeyPairSync('x25519')
  const ephPub = exportRawPub(eph.publicKey)
  const key = deriveKey(eph.privateKey, importPub(ownerPub), ephPub, ownerPub)
  const nonce = crypto.randomBytes(12)
  const header = Buffer.concat([Buffer.from(MAGIC), Buffer.from([keyId])])
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce)
  c.setAAD(header)
  const ct = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([header, ephPub, nonce, ct, c.getAuthTag()])
}

function open(sealed, privateKeyPem) {
  if (sealed.length < OVERHEAD) throw new Error('ARB_TRUNCATED')
  if (sealed.subarray(0, 4).toString() !== MAGIC) throw new Error('ARB_BAD_MAGIC')
  const header = sealed.subarray(0, 5)
  const ephPub = sealed.subarray(5, 37)
  const nonce = sealed.subarray(37, 49)
  const ct = sealed.subarray(49, sealed.length - 16)
  const tag = sealed.subarray(sealed.length - 16)
  const privateKey = crypto.createPrivateKey(privateKeyPem)
  const ownerPub = exportRawPub(crypto.createPublicKey(privateKey))
  const key = deriveKey(privateKey, importPub(ephPub), ephPub, ownerPub)
  const d = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  d.setAAD(header)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(ct), d.final()])   // a bad tag throws here
}

module.exports = { MAGIC, KEY_ID, INFO, OWNER_PUB_B64, OVERHEAD, seal, open }
