// Stubbed tests for Windows CI dispatch and fallback lookup in desktop/publish-github.sh:
// real `gh workflow run` failures must stop immediately instead of being swallowed, while
// a successful dispatch that prints no URL still falls back to `gh run list`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname

function runPublish(ghBehavior) {
  const dir = mkdtempSync(join(tmpdir(), 'pub-ci-'))
  const repo = join(dir, 'repo')
  const bin = join(dir, 'bin')
  mkdirSync(join(repo, 'desktop/market-seed'), { recursive: true })
  mkdirSync(join(repo, 'desktop/release'), { recursive: true })
  mkdirSync(join(repo, 'ops'), { recursive: true })
  mkdirSync(bin)

  const ver = '0.3.99-beta.1'
  writeFileSync(join(repo, 'desktop/package.json'), JSON.stringify({ version: ver }) + '\n')
  cpSync(join(ROOT, 'desktop/publish-github.sh'), join(repo, 'desktop/publish-github.sh'))

  // Valid seed + Mac artifacts for --no-build.
  const gz = execFileSync('bash', ['-c', 'printf ok | gzip'])
  writeFileSync(join(repo, 'desktop/market-seed/market-seed.sqlite.gz'), gz)
  writeFileSync(join(repo, 'desktop/market-seed/market-seed.sqlite.gz.version'), '123\n')
  for (const f of [
    `Arbiter-${ver}-arm64.dmg`,
    `Arbiter-${ver}-arm64.dmg.blockmap`,
    `Arbiter-${ver}-arm64-mac.zip`,
    `Arbiter-${ver}-arm64-mac.zip.blockmap`,
    'beta-mac.yml',
  ]) {
    writeFileSync(join(repo, 'desktop/release', f), 'x')
  }

  writeFileSync(join(repo, 'ops/run-tests.sh'), '#!/bin/bash\nexit 0\n')
  chmodSync(join(repo, 'ops/run-tests.sh'), 0o755)
  writeFileSync(join(repo, 'desktop/prune-release.sh'), '#!/bin/bash\nexit 0\n')
  chmodSync(join(repo, 'desktop/prune-release.sh'), 0o755)

  writeFileSync(
    join(bin, 'git'),
    `#!/bin/bash
echo "git $*" >> "${dir}/calls.log"
case "$1" in
  branch) echo main ;;
  diff) exit 0 ;;
  rev-parse) echo deadbeef ;;
  *) exit 0 ;;
esac
`,
  )
  chmodSync(join(bin, 'git'), 0o755)

  writeFileSync(
    join(bin, 'node'),
    `#!/bin/bash
echo "node $*" >> "${dir}/calls.log"
if [ "$1" = "-p" ]; then echo "${ver}"; exit 0; fi
if [ "$1" = "scripts/release-assets.mjs" ] && [ "$2" = "has" ]; then exit 1; fi
exit 0
`,
  )
  chmodSync(join(bin, 'node'), 0o755)

  writeFileSync(
    join(bin, 'python3'),
    `#!/bin/bash
echo "python3 $*" >> "${dir}/calls.log"
exit 0
`,
  )
  chmodSync(join(bin, 'python3'), 0o755)

  writeFileSync(
    join(bin, 'sleep'),
    '#!/bin/bash\nexit 0\n',
  )
  chmodSync(join(bin, 'sleep'), 0o755)

  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/bash
echo "gh $*" >> "${dir}/calls.log"
${ghBehavior}
`,
  )
  chmodSync(join(bin, 'gh'), 0o755)

  const res = spawnSync('bash', [join(repo, 'desktop/publish-github.sh'), '--no-build'], {
    cwd: join(repo, 'desktop'),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  })
  const calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n')
  return { res, calls }
}

test('a failing gh workflow run stops publish-github.sh immediately', () => {
  const { res, calls } = runPublish(`
if [ "$1" = "workflow" ]; then
  echo "workflow dispatch rejected" >&2
  exit 1
fi
exit 0
`)
  assert.notEqual(res.status, 0)
  assert.equal(calls.some((c) => c.startsWith('gh run list')), false, 'must not enter fallback loop after failed dispatch')
})

test('a URL-less gh workflow run falls back to gh run list and retries past a transient list failure', () => {
  const { res, calls } = runPublish(`
if [ "$1" = "workflow" ]; then
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  n=$(cat "$(dirname "$0")/list-count" 2>/dev/null || echo 0)
  n=$((n + 1))
  echo "$n" > "$(dirname "$0")/list-count"
  if [ "$n" -eq 1 ]; then
    echo "transient 502" >&2
    exit 1
  fi
  echo "987654"
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "watch" ]; then
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "view" ]; then
  echo "seed ready (1.2M, v123):"
  exit 0
fi
exit 0
`)
  assert.equal(res.status, 0, res.stderr + res.stdout)
  assert.equal(calls.filter((c) => c.startsWith('gh run list')).length, 2)
  assert.ok(calls.some((c) => c.startsWith('gh run watch 987654')))
})
