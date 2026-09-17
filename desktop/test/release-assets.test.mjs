// The release go-live check (docs/bugs/2026-09-17-release-publish-not-atomic.md): a release may only
// become public when every file a client can be sent to is really there.
import test from 'node:test'
import assert from 'node:assert/strict'
import { expectedManifests, manifestFiles, problems, uploadOrder } from '../scripts/release-assets.mjs'

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
