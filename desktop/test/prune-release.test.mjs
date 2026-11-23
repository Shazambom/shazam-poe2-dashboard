// desktop/release/ kept every Mac build ever cut: 160 versions of a .dmg and a .zip filled the disk.
// publish-github.sh now calls prune-release.sh once a release is live, which deletes the Mac installers
// of every OTHER version and nothing else.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = new URL('../prune-release.sh', import.meta.url).pathname
const publish = readFileSync(new URL('../publish-github.sh', import.meta.url), 'utf8')

const installers = v => [`Arbiter-${v}-arm64.dmg`, `Arbiter-${v}-arm64.dmg.blockmap`,
  `Arbiter-${v}-arm64-mac.zip`, `Arbiter-${v}-arm64-mac.zip.blockmap`]
const KEPT_ALWAYS = ['latest-mac.yml', 'beta-mac.yml', 'builder-debug.yml', 'builder-effective-config.yaml',
  'notes.txt', 'Arbiter-Setup-0.3.16.exe']

function release(versions) {
  const dir = mkdtempSync(join(tmpdir(), 'prune-release-'))
  for (const v of versions) for (const f of installers(v)) writeFileSync(join(dir, f), 'x')
  for (const f of KEPT_ALWAYS) writeFileSync(join(dir, f), 'x')
  mkdirSync(join(dir, 'mac-arm64', 'Arbiter.app'), { recursive: true })
  writeFileSync(join(dir, 'mac-arm64', 'Arbiter.app', 'Arbiter-0.3.1-arm64.dmg'), 'x')   // nested: never touched
  return dir
}
const run = (...args) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' })

test('only the released version\'s Mac installers survive; everything else in release/ is left alone', () => {
  const dir = release(['0.3.15', '0.3.16', '0.3.17-beta.4', '0.3.17'])
  const r = run('0.3.17', dir)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(readdirSync(dir).sort(), [...installers('0.3.17'), ...KEPT_ALWAYS, 'mac-arm64'].sort())
  assert.deepEqual(readdirSync(join(dir, 'mac-arm64', 'Arbiter.app')), ['Arbiter-0.3.1-arm64.dmg'])
  assert.match(r.stdout, /removed 12 old Mac installer file\(s\)/)
})

test('a beta release keeps the beta and removes the stable it replaced locally', () => {
  const dir = release(['0.3.17', '0.3.18-beta.1'])
  assert.equal(run('0.3.18-beta.1', dir).status, 0)
  assert.deepEqual(readdirSync(dir).filter(f => f.startsWith('Arbiter-') && !f.endsWith('.exe')).sort(), installers('0.3.18-beta.1').sort())
})

test('a version whose own installers are not there removes nothing (a wrong version must not empty release/)', () => {
  const dir = release(['0.3.16', '0.3.17'])
  const before = readdirSync(dir).sort()
  const r = run('0.3.99', dir)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /Arbiter-0\.3\.99-arm64\.dmg is not in/)
  assert.deepEqual(readdirSync(dir).sort(), before)
})

test('no version, or a release directory that does not exist, is refused', () => {
  assert.equal(run().status, 2)
  assert.equal(run('').status, 2)
  assert.equal(run('0.3.17', join(tmpdir(), 'no-such-release-dir')).status, 1)
})

test('nothing to remove is a success', () => {
  const dir = release(['0.3.17'])
  const r = run('0.3.17', dir)
  assert.equal(r.status, 0)
  assert.match(r.stdout, /no old Mac installers/)
})

test('publish-github.sh prunes only after the release is live, and a prune failure never fails the release', () => {
  const live = publish.indexOf('is live on both platforms')
  const prune = publish.indexOf('./prune-release.sh "$VER"')
  assert.ok(live > 0 && prune > live, 'the prune runs after the go-live line')
  assert.match(publish, /if ! \.\/prune-release\.sh "\$VER"; then\n\s+echo "WARNING: /)
})
