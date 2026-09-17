// The release go-live check (docs/bugs/2026-09-17-release-publish-not-atomic.md): a release may only
// become public when every file a client can be sent to is really there.
import test from 'node:test'
import assert from 'node:assert/strict'
import { expectedManifests, manifestFiles, problems, stalled, uploadOrder } from '../scripts/release-assets.mjs'

const MAC_YML = `version: 0.2.60
files:
  - url: Arbiter-0.2.60-arm64-mac.zip
    sha512: NLAd==
    size: 177647335
  - url: Arbiter-0.2.60-arm64.dmg
    sha512: 2Ud7==
    size: 182102371
path: Arbiter-0.2.60-arm64-mac.zip
sha512: NLAd==
releaseDate: '2026-09-17T18:15:31.722Z'
`
const WIN_YML = `version: 0.2.60
files:
  - url: Arbiter-Setup-0.2.60.exe
    sha512: abc==
    size: 178236161
path: Arbiter-Setup-0.2.60.exe
sha512: abc==
releaseDate: '2026-09-17T18:10:00.000Z'
`
const up = (name, size) => ({ name, state: 'uploaded', size })
const FULL = [
  up('Arbiter-0.2.60-arm64-mac.zip', 177647335), up('Arbiter-0.2.60-arm64.dmg', 182102371),
  up('Arbiter-Setup-0.2.60.exe', 178236161), up('latest.yml', 346), up('latest-mac.yml', 509),
]
const MANIFESTS = { 'latest.yml': WIN_YML, 'latest-mac.yml': MAC_YML }
const TAG = 'desktop-v0.2.60'

test('manifests upload last, whatever order they were given in', () => {
  const order = uploadOrder(['release/latest-mac.yml', 'release/a.dmg', 'release/beta.yml', 'release/a.zip'])
  assert.deepEqual(order, ['release/a.dmg', 'release/a.zip', 'release/latest-mac.yml', 'release/beta.yml'])
})

test('a manifest names every file it lists, with sizes, plus path', () => {
  assert.deepEqual(manifestFiles(MAC_YML), [
    { name: 'Arbiter-0.2.60-arm64-mac.zip', size: 177647335 },
    { name: 'Arbiter-0.2.60-arm64.dmg', size: 182102371 },
  ])
  assert.deepEqual(manifestFiles('path: only.exe\nsha512: x\n'), [{ name: 'only.exe', size: null }])
})

test('channel decides the manifests', () => {
  assert.deepEqual(expectedManifests('desktop-v0.2.60'), ['latest.yml', 'latest-mac.yml'])
  assert.deepEqual(expectedManifests('0.2.60-beta.1'), ['beta.yml', 'beta-mac.yml'])
})

test('a complete release has no problems', () => {
  assert.deepEqual(problems(TAG, FULL, MANIFESTS), [])
})

test('18:28 UTC incident: manifest live, zip and dmg half-created', () => {
  const assets = FULL.map((a) => (/zip$|dmg$/.test(a.name) ? { ...a, state: 'starter', size: 0 } : a))
  const bad = problems(TAG, assets, MANIFESTS)
  assert.ok(bad.some((b) => b.startsWith('Arbiter-0.2.60-arm64-mac.zip: state "starter"')))
  assert.ok(bad.some((b) => b.startsWith('Arbiter-0.2.60-arm64.dmg: state "starter"')))
})

test('19:13 UTC incident: zip fine but the DMG the Mac updater opens is absent', () => {
  const bad = problems(TAG, FULL.filter((a) => !a.name.endsWith('.dmg')), MANIFESTS)
  assert.ok(bad.some((b) => b.startsWith('Arbiter-0.2.60-arm64.dmg: missing')))
})

test('Windows-only release (Mac half not uploaded yet) cannot go live', () => {
  const bad = problems(TAG, FULL.filter((a) => a.name.includes('Setup') || a.name === 'latest.yml'), { 'latest.yml': WIN_YML })
  assert.ok(bad.includes('latest-mac.yml: missing (channel manifest)'))
})

test('a truncated file is caught by the manifest size', () => {
  const assets = FULL.map((a) => (a.name.endsWith('.exe') ? { ...a, size: 1000 } : a))
  assert.deepEqual(problems(TAG, assets, MANIFESTS), ['Arbiter-Setup-0.2.60.exe: size 1000 != 178236161 (named by latest.yml)'])
})

test('a stray half-created asset blocks go-live even if no manifest names it', () => {
  const bad = problems(TAG, [...FULL, { name: 'Arbiter-0.2.60-win.zip', state: 'starter', size: 0 }], MANIFESTS)
  assert.deepEqual(bad, ['Arbiter-0.2.60-win.zip: state "starter" (half-created asset)'])
})

test('beta release is checked against the beta manifests', () => {
  const bad = problems('0.2.60-beta.1', FULL, MANIFESTS)
  assert.ok(bad.includes('beta.yml: missing (channel manifest)'))
  assert.ok(bad.includes('beta-mac.yml: missing (channel manifest)'))
})

// ---- cut-our-losses rule: an upload whose speed collapses is killed and retried -----------------
const RULE = { minBps: 300 * 1024, windowMs: 30000 }
const TOTAL = 180e6
// samples every 2 s at the given bytes/s profile: [[seconds, bytesPerSec], ...]
const run = (...legs) => { const out = [{ t: 0, bytes: 0 }]; let t = 0, b = 0
  for (const [secs, bps] of legs) for (let i = 0; i < secs; i += 2) { t += 2000; b += bps * 2; out.push({ t, bytes: Math.min(b, TOTAL) }) }
  return out }

test('a healthy upload is never cut', () => {
  const s = run([120, 1.5e6])
  for (let i = 1; i <= s.length; i++) assert.equal(stalled(s.slice(0, i), TOTAL, RULE), false)
})
test('nothing is judged before a full window of history', () => {
  assert.equal(stalled(run([28, 1000]), TOTAL, RULE), false)
  assert.equal(stalled(run([32, 1000]), TOTAL, RULE), true)
})
test('0.2.61-beta.1: fast start, then ~47 KB/s — cut about 30 s after the collapse, not at 20 min', () => {
  const s = run([60, 2.2e6], [60, 47 * 1024])
  const cutAt = s.findIndex((_, i) => stalled(s.slice(0, i + 1), TOTAL, RULE))
  assert.ok(s[cutAt].t > 60000 && s[cutAt].t <= 60000 + 32000, `cut at ${s[cutAt].t} ms`)
})
test('a dead-stopped connection (0 KB/s) is cut', () => {
  assert.equal(stalled(run([20, 3e6], [34, 0]), TOTAL, RULE), true)
})
test('a brief dip that recovers inside the window is tolerated', () => {
  const s = run([40, 2e6], [10, 0], [20, 2e6])
  for (let i = 1; i <= s.length; i++) assert.equal(stalled(s.slice(0, i), TOTAL, RULE), false)
})
test('once every byte is sent, waiting for GitHub to answer is not a stall', () => {
  assert.equal(stalled([...run([20, 9e6]), { t: 60000, bytes: TOTAL }, { t: 100000, bytes: TOTAL }], TOTAL, RULE), false)
})
