// Stubbed shell-level test for EE2 sync failure rollback in desktop/publish-github.sh:
// if sync-ee2.mjs dies partway after mutating vendored files or goldens, publish-github.sh
// must restore both paths to HEAD and exit non-zero so the next run's test gate is not broken.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname

function runFailedSync({ stagedBroken = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pub-sync-rollback-'))
  try {
    const repo = join(dir, 'repo')
    const bin = join(dir, 'bin')
    const vendorDir = join(repo, 'desktop/src/vendor/ee2-query/data')
    const goldenDir = join(repo, 'desktop/test/goldens/ee2-query')
    mkdirSync(vendorDir, { recursive: true })
    mkdirSync(goldenDir, { recursive: true })
    mkdirSync(join(repo, 'ops'), { recursive: true })
    mkdirSync(bin)

    const ver = '0.3.99-beta.1'
    writeFileSync(join(repo, 'desktop/package.json'), JSON.stringify({ version: ver }) + '\n')
    cpSync(join(ROOT, 'desktop/publish-github.sh'), join(repo, 'desktop/publish-github.sh'))
    writeFileSync(join(vendorDir, 'MANIFEST.json'), '{"ee2Tag":"v0.1.0"}\n')
    writeFileSync(join(goldenDir, 'sample.json'), '{"ok":true}\n')
    writeFileSync(join(repo, 'ops/run-tests.sh'), '#!/bin/bash\nexit 0\n')
    chmodSync(join(repo, 'ops/run-tests.sh'), 0o755)

    const git = (args) => execFileSync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
      encoding: 'utf8',
    })
    git(['init', '-b', 'main'])
    git(['add', '.'])
    git(['commit', '-q', '-m', 'init'])
    // An earlier run whose sync succeeded staged its files (`git add -A`) before its test gate failed.
    if (stagedBroken) {
      writeFileSync(join(vendorDir, 'MANIFEST.json'), '{"ee2Tag":"v9.9.9-broken"}\n')
      git(['add', '-A'])
    }

    writeFileSync(
      join(bin, 'node'),
      `#!/bin/bash
if [ "$1" = "-p" ]; then
  echo "${ver}"
  exit 0
fi
if [ "$1" = "scripts/sync-ee2.mjs" ]; then
  echo '{"corrupted":true}' > src/vendor/ee2-query/data/MANIFEST.json
  echo 'partial' > src/vendor/ee2-query/data/partial.tmp
  rm -f test/goldens/ee2-query/sample.json
  echo 'stray' > test/goldens/ee2-query/stray.json
  echo "simulated network error" >&2
  exit 1
fi
exit 0
`,
    )
    chmodSync(join(bin, 'node'), 0o755)

    const res = spawnSync('bash', [join(repo, 'desktop/publish-github.sh'), '--no-build'], {
      cwd: join(repo, 'desktop'),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    })

    assert.notEqual(res.status, 0, 'publish-github.sh must exit non-zero when sync-ee2.mjs fails')
    assert.match(res.stdout + res.stderr, /restored/i, 'must report that vendored files were restored')

    const status = git(['status', '--porcelain', '--', 'desktop/src/vendor/ee2-query', 'desktop/test/goldens/ee2-query']).trim()
    assert.equal(status, '', 'vendored files and goldens must be clean after failed sync')
    assert.equal(readFileSync(join(vendorDir, 'MANIFEST.json'), 'utf8'), '{"ee2Tag":"v0.1.0"}\n')
    assert.equal(readFileSync(join(goldenDir, 'sample.json'), 'utf8'), '{"ok":true}\n')
    assert.equal(git(['diff', '--cached', '--name-only', '--', 'desktop/src/vendor/ee2-query', 'desktop/test/goldens/ee2-query']).trim(), '',
      'nothing staged under the vendored paths after the rollback')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a failing sync-ee2.mjs restores vendored files and goldens to HEAD and exits non-zero', () => runFailedSync())

// `git checkout -- <paths>` restores from the index; a previous run's staged sync would survive it.
test('a failing sync-ee2.mjs restores HEAD even over changes an earlier run staged', () => runFailedSync({ stagedBroken: true }))
