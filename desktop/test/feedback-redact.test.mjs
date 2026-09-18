// Pins desktop/src/feedback/redact.js — a report never carries a credential.
import test from 'node:test'
import assert from 'node:assert/strict'

const { SETTINGS_KEYS, pickAllowed, scrubText, redactDeep } = await import('../src/feedback/redact.js')

// Every seed below is a secret shape the app has ever handled; NONE may survive redaction.
const SEEDS = {
  poesessid: 'POESESSID=0123456789abcdef0123456789abcdef',
  cookieHeader: 'Cookie: POESESSID=deadbeefdeadbeefdeadbeefdeadbeef; other=1',
  bearer: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  refreshToken: '"refresh_token": "rt-9f8e7d6c5b4a39281706f5e4d3c2b1a0"',
  fernet: 'gAAAAABl3v2XfQk1Zm9vYmFyYmF6cXV4cXV1eA==-abcdefghijklmnopqrstuvwxyz0123456789',
  oauthCallback: 'http://127.0.0.1:8210/callback?code=4/0AbCdEfGhIjKlMnOpQrStUvWxYz&state=xyz123',
  hexKey: 'api key = 0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c',
}
const values = (o) => JSON.stringify(o)

test('scrubText removes every secret shape and leaves plain text alone', () => {
  for (const [name, s] of Object.entries(SEEDS)) {
    const out = scrubText(`before ${s} after`)
    assert.ok(!out.includes(s.replace(/^[^=:\s]+[=:]\s*/, '').slice(-12)), `${name} leaked: ${out}`)
    assert.match(out, /before .*after|before .*\[redacted\]/, name)
  }
  assert.equal(scrubText('Divine Orb 312.5 exalted, spread 1.2%'), 'Divine Orb 312.5 exalted, spread 1.2%')
  assert.equal(scrubText('[backend] GET /api/board 200 12ms'), '[backend] GET /api/board 200 12ms')
})

test('redactDeep scrubs every string in a tree and drops credential-named keys', () => {
  const poisoned = {
    league: 'Rise of the Abyssal',
    session: { cookie: SEEDS.poesessid, label: 'desktop' },
    oauth: { access_token: 'abc', logged_in: true, username: 'Player' },
    Authorization: SEEDS.bearer,
    notes: [SEEDS.cookieHeader, SEEDS.fernet, { deep: SEEDS.refreshToken }],
    url: SEEDS.oauthCallback,
    key_hex: SEEDS.hexKey,
    n: 42, ok: false, nothing: null,
  }
  const out = redactDeep(poisoned)
  const s = values(out)
  for (const [name, seed] of Object.entries(SEEDS)) assert.ok(!s.includes(seed.slice(-12)), `${name} leaked: ${s}`)
  assert.equal(out.league, 'Rise of the Abyssal')
  assert.equal(out.n, 42); assert.equal(out.ok, false); assert.equal(out.nothing, null)
  assert.ok(!('session' in out) && !('Authorization' in out), 'credential-named keys dropped')
  assert.ok(!('access_token' in out.oauth) && out.oauth.logged_in === true, 'nested credential key dropped, siblings kept')
  assert.ok(Array.isArray(out.notes) && out.notes.length === 3)
})

test('redactDeep tolerates cycles, depth and non-object input', () => {
  const a = { name: 'x' }; a.self = a
  assert.equal(redactDeep(a).name, 'x')
  assert.equal(redactDeep('POESESSID=abc'), '[redacted]')
  assert.equal(redactDeep(undefined), undefined)
})

test('pickAllowed keeps only allow-listed keys (fail-closed)', () => {
  assert.ok(Array.isArray(SETTINGS_KEYS) && SETTINGS_KEYS.includes('league') && SETTINGS_KEYS.includes('reference'))
  assert.ok(!SETTINGS_KEYS.some(k => /sess|cookie|token|secret/i.test(k)))
  const out = pickAllowed({ league: 'L', reference: 'divine', harmless_unknown: 1, poesessid: 'x' }, SETTINGS_KEYS)
  assert.deepEqual(out, { league: 'L', reference: 'divine' })
  assert.deepEqual(pickAllowed(null, SETTINGS_KEYS), {})
})
