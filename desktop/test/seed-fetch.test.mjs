// 0.3.12-beta.2 shipped a Windows build with NO market snapshot: shazam's cron was replacing the
// market-seed-latest asset while CI downloaded it, so only the 10-byte .version sidecar arrived and the
// inline CI step never checked for the snapshot itself. Both platforms now fetch through fetch-seed.sh,
// which waits out a replace window and fails rather than build seedless; publish-github.sh refuses a
// Windows build whose log lacks the script's "seed ready" line.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DESKTOP = new URL('..', import.meta.url).pathname
const ci = readFileSync(new URL('../../.github/workflows/release-desktop-win.yml', import.meta.url), 'utf8')
const publish = readFileSync(new URL('../publish-github.sh', import.meta.url), 'utf8')

// A sandbox copy of fetch-seed.sh with a fake `gh` whose Nth call writes what `answers[N]` says.
function sandbox(answers) {
  const dir = mkdtempSync(join(tmpdir(), 'seedfetch-'))
  cpSync(join(DESKTOP, 'fetch-seed.sh'), join(dir, 'fetch-seed.sh'))
  const bin = join(dir, 'bin'); mkdirSync(bin)
  const gz = execFileSync('bash', ['-c', 'head -c 200000 /dev/urandom | gzip | base64'], { maxBuffer: 1 << 24 }).toString().replace(/\n/g, '')
  writeFileSync(join(dir, 'answers.json'), JSON.stringify(answers))
  writeFileSync(join(dir, 'gz.b64'), gz)
  writeFileSync(join(bin, 'gh'), `#!/bin/bash
# fake gh release download ... --dir <d>
n=$(cat "${dir}/calls" 2>/dev/null || echo 0); echo $((n+1)) > "${dir}/calls"
while [ $# -gt 0 ]; do [ "$1" = "--dir" ] && d="$2"; shift; done
a=$(node -e "const a=require('${dir}/answers.json'); console.log(a[Math.min(${'$'}n, a.length-1)])")
mkdir -p "$d"; rm -f "$d"/market-seed.sqlite.gz*
case "$a" in
  both) base64 -d < "${dir}/gz.b64" > "$d/market-seed.sqlite.gz"; echo 1791073354 > "$d/market-seed.sqlite.gz.version" ;;
  version-only) echo 1791073354 > "$d/market-seed.sqlite.gz.version" ;;
  corrupt) echo "not gzip" > "$d/market-seed.sqlite.gz"; echo 1791073354 > "$d/market-seed.sqlite.gz.version" ;;
esac
exit 0
`)
  chmodSync(join(bin, 'gh'), 0o755)
  const run = () => spawnSync('bash', [join(dir, 'fetch-seed.sh')], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FETCH_SEED_WAIT_S: '0' }, encoding: 'utf8' })
  const calls = () => Number(readFileSync(join(dir, 'calls'), 'utf8'))
  return { run, calls }
}

test('a fetch during the cron replace window waits for the snapshot, then succeeds', () => {
  const s = sandbox(['version-only', 'version-only', 'both'])
  const r = s.run()
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.equal(s.calls(), 3, 'retried until the snapshot itself arrived')
  assert.match(r.stdout, /^seed ready \(/m)
})

test('a corrupt snapshot is fetched again', () => {
  const s = sandbox(['corrupt', 'both'])
  assert.equal(s.run().status, 0)
  assert.equal(s.calls(), 2)
})

test('a snapshot that never arrives fails the build instead of shipping seedless', () => {
  const s = sandbox(['version-only'])
  const r = s.run()
  assert.notEqual(r.status, 0)
  assert.doesNotMatch(r.stdout, /^seed ready \(/m)
  assert.ok(s.calls() > 1, 'it retried before giving up')
})

test('Windows CI fetches the seed through the same script as the Mac build', () => {
  assert.match(ci, /bash desktop\/fetch-seed\.sh/)
  assert.doesNotMatch(ci, /gh release download market-seed-latest/, 'no second, unchecked download path')
})

test('publish refuses a Windows build whose CI log shows no checked seed', () => {
  assert.match(publish, /gh run view "\$RID"[^\n]*--log \| grep -q 'seed ready \('/)
})
