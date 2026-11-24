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
  const dispatchIdx = calls.findIndex((c) => c.startsWith('gh workflow run'))
  assert.notEqual(dispatchIdx, -1, 'must attempt workflow dispatch')
  assert.equal(
    calls.slice(dispatchIdx + 1).some((c) => c.startsWith('gh run list')),
    false,
    'must not enter fallback loop after failed dispatch',
  )
})

test('a URL-less gh workflow run falls back to gh run list and retries past a transient list failure', () => {
  const { res, calls } = runPublish(`
if [ "$1" = "workflow" ]; then
  touch "$(dirname "$0")/dispatched"
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  if [ ! -f "$(dirname "$0")/dispatched" ]; then
    exit 0
  fi
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
  const dispatchIdx = calls.findIndex((c) => c.startsWith('gh workflow run'))
  assert.notEqual(dispatchIdx, -1)
  assert.equal(calls.slice(dispatchIdx + 1).filter((c) => c.startsWith('gh run list')).length, 2)
  assert.ok(calls.some((c) => c.startsWith('gh run watch 987654')))
})

test('an in-progress Windows build for the tag is adopted without dispatching a duplicate run', () => {
  const { res, calls } = runPublish(`
if [ "$1" = "workflow" ]; then
  echo "should not dispatch a duplicate workflow run" >&2
  exit 99
fi
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  if echo "$*" | grep -q 'Windows build 0.3.99-beta.1'; then
    echo "445566"
    exit 0
  fi
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
  assert.equal(calls.some((c) => c.startsWith('gh workflow run')), false, 'must not invoke gh workflow run when an unfinished run exists')
  assert.ok(calls.some((c) => c.startsWith('gh run watch 445566')), 'must watch the adopted run id')
})

// A stub `gh run list` that applies the script's own -q filter to fixture runs with jq, so the
// test checks what the query selects rather than how it is spelled.
const listRuns = (runs) => `
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  q=""; while [ $# -gt 0 ]; do [ "$1" = "-q" ] && q="$2"; shift; done
  echo '${JSON.stringify(runs)}' | jq -r "$q"
  exit 0
fi`

// The script pushes main and dispatches with sha = main's head, so a run started by an earlier
// attempt from an OLDER commit has a different headSha. Adopting it would ship a Windows build of
// the old code beside a Mac build of the new one: the script must dispatch instead (the workflow's
// per-tag concurrency group then runs the new build after the old one, never interleaved).
test('an unfinished Windows build for the tag from an older commit is not adopted', () => {
  const { res, calls } = runPublish(`
${listRuns([{ databaseId: 445566, displayTitle: 'Windows build 0.3.99-beta.1', status: 'in_progress', headSha: 'oldc0mmit' }])}
if [ "$1" = "workflow" ]; then echo "https://github.com/x/y/actions/runs/778899"; exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "watch" ]; then exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "view" ]; then echo "seed ready (1.2M, v123):"; exit 0; fi
exit 0
`)
  assert.equal(res.status, 0, res.stderr + res.stdout)
  assert.ok(calls.some((c) => c.startsWith('gh workflow run')), 'a build of an older commit must not be adopted')
  assert.ok(calls.some((c) => c.startsWith('gh run watch 778899')), 'must watch the newly dispatched run')
})

test('an unfinished Windows build for the tag from the same commit is adopted (query checked with jq)', () => {
  const { res, calls } = runPublish(`
${listRuns([{ databaseId: 445566, displayTitle: 'Windows build 0.3.99-beta.1', status: 'in_progress', headSha: 'deadbeef' }])}
if [ "$1" = "workflow" ]; then echo "should not dispatch" >&2; exit 99; fi
if [ "$1" = "run" ] && [ "$2" = "watch" ]; then exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "view" ]; then echo "seed ready (1.2M, v123):"; exit 0; fi
exit 0
`)
  assert.equal(res.status, 0, res.stderr + res.stdout)
  assert.equal(calls.some((c) => c.startsWith('gh workflow run')), false)
  assert.ok(calls.some((c) => c.startsWith('gh run watch 445566')))
})

// The fallback after a URL-less dispatch must apply the same commit filter as the adoption step, or it
// can pick up an older commit's build still running for the tag and ship its Windows binaries.
test('the URL-less fallback watches the build of this commit, not an older one for the same tag', (t) => {
  const prevTmp = process.env.TMPDIR
  process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'pub-ci-marker-'))
  t.after(() => { process.env.TMPDIR = prevTmp })
  const older = { databaseId: 445566, displayTitle: 'Windows build 0.3.99-beta.1', status: 'in_progress', headSha: 'oldc0mmit' }
  const ours = { databaseId: 778899, displayTitle: 'Windows build 0.3.99-beta.1', status: 'queued', headSha: 'deadbeef' }
  // Only the older build exists until the dispatch; this commit's build appears after it (no URL printed).
  const { res, calls } = runPublish(`
if [ "$1" = "run" ] && [ "$2" = "list" ]; then
  q=""; while [ $# -gt 0 ]; do [ "$1" = "-q" ] && q="$2"; shift; done
  if [ -f "$TMPDIR/dispatched" ]; then runs='${JSON.stringify([older, ours])}'; else runs='${JSON.stringify([older])}'; fi
  echo "$runs" | jq -r "$q"
  exit 0
fi
if [ "$1" = "workflow" ]; then touch "$TMPDIR/dispatched"; exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "watch" ]; then exit 0; fi
if [ "$1" = "run" ] && [ "$2" = "view" ]; then echo "seed ready (1.2M, v123):"; exit 0; fi
exit 0
`)
  assert.equal(res.status, 0, res.stderr + res.stdout)
  assert.ok(calls.some((c) => c.startsWith('gh workflow run')), 'the older build is not adopted, so it dispatches')
  assert.ok(calls.some((c) => c.startsWith('gh run watch 778899')), 'must watch this commit\'s build')
  assert.equal(calls.some((c) => c.startsWith('gh run watch 445566')), false)
})
