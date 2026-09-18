// Pins desktop/src/feedback/seal.js — the .arb envelope (X25519 → HKDF-SHA256 → AES-256-GCM).
// Run:  node --test desktop/test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const { MAGIC, KEY_ID, OWNER_PUB_B64, OVERHEAD, seal, open } = await import('../src/feedback/seal.js')

// A throwaway owner keypair: raw 32-byte public key (base64) + PEM private key.
function testKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  return { pub: spki.subarray(spki.length - 32).toString('base64'), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
}

test('constants: ARB1 magic, one key id, a 32-byte owner public key, 65 bytes of overhead', () => {
  assert.equal(MAGIC, 'ARB1')
  assert.ok(Number.isInteger(KEY_ID) && KEY_ID >= 0 && KEY_ID < 256)
  assert.equal(Buffer.from(OWNER_PUB_B64, 'base64').length, 32)
  assert.equal(OVERHEAD, 65)
})

test('seal → open round-trips; overhead is exactly 65 bytes; two seals of the same plaintext differ', () => {
  const k = testKeys()
  const plain = Buffer.from('hello feedback ' + 'x'.repeat(1000))
  const a = seal(plain, k.pub)
  const b = seal(plain, k.pub)
  assert.equal(a.length, plain.length + OVERHEAD)
  assert.equal(a.subarray(0, 4).toString(), 'ARB1')
  assert.equal(a[4], KEY_ID)
  assert.notDeepEqual(a, b, 'ephemeral key + nonce make every seal unique')
  assert.deepEqual(open(a, k.priv), plain)
  assert.deepEqual(open(b, k.priv), plain)
})

test('the empty plaintext seals and opens', () => {
  const k = testKeys()
  assert.deepEqual(open(seal(Buffer.alloc(0), k.pub), k.priv), Buffer.alloc(0))
})

test('flipping any byte — magic, keyId, ephPub, nonce, ciphertext, tag — fails to open', () => {
  const k = testKeys()
  const sealed = seal(Buffer.from('payload'), k.pub)
  const probes = { magic: 0, keyId: 4, ephPub: 5 + 7, nonce: 5 + 32 + 3, ciphertext: 65 - 16 + 2, tag: sealed.length - 1 }
  for (const [what, i] of Object.entries(probes)) {
    const bad = Buffer.from(sealed)
    bad[i] ^= 0x01
    assert.throws(() => open(bad, k.priv), what)
  }
})

test('the wrong private key fails; truncated input throws a named error', () => {
  const k = testKeys(), other = testKeys()
  const sealed = seal(Buffer.from('payload'), k.pub)
  assert.throws(() => open(sealed, other.priv))
  assert.throws(() => open(sealed.subarray(0, 40), k.priv), /ARB_TRUNCATED/)
  assert.throws(() => open(Buffer.from('NOPE' + 'x'.repeat(80)), k.priv), /ARB_BAD_MAGIC/)
})

// Cross-language pin: a file sealed by ops/feedback-bot/arbseal.py opens here.
const FIX = new URL('./fixtures/feedback/', import.meta.url).pathname
test('opens a file sealed by the Python side (fixture)', { skip: !existsSync(join(FIX, 'sealed-by-python.arb')) && 'fixture missing' }, () => {
  const priv = readFileSync(join(FIX, 'test-key.pem'), 'utf8')
  const got = open(readFileSync(join(FIX, 'sealed-by-python.arb')), priv)
  assert.equal(got.toString(), readFileSync(join(FIX, 'plain.txt'), 'utf8'))
})

// Structural: no private key ever lives in the app; exactly one owner-pubkey literal.
const SRC = new URL('../src/', import.meta.url).pathname
const walk = (d) => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p] })
const files = walk(SRC).filter(f => f.endsWith('.js') && !f.includes('node_modules'))

test('the owner public key ships as feedback/owner-key.pub (32 bytes, minted on shazam); no private key, no second copy under desktop/src', () => {
  const pub = readFileSync(join(SRC, 'feedback', 'owner-key.pub'), 'utf8').trim()
  assert.equal(pub, OWNER_PUB_B64)
  assert.equal(Buffer.from(pub, 'base64').length, 32)
  assert.deepEqual(files.filter(f => /BEGIN (EC |X25519 )?PRIVATE KEY/.test(readFileSync(f, 'utf8'))), [])
  assert.deepEqual(files.filter(f => readFileSync(f, 'utf8').includes(pub)), [], 'the key lives in the .pub file, not in code')
  // The test keypair's public key is never the shipped one.
  const testPub = readFileSync(join(FIX, 'pub.b64'), 'utf8').trim()
  assert.notEqual(pub, testPub)
})
