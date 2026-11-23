import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DATA_EXT, EVERY_TEXT, NOT_LINTED, STEP_NAMES, classify, interpreterOf, listFor, notLinted, ownersOf,
} from './files.mjs'
import {
  ASK, BASE, BIG_FILE_ALLOWED, PINNED_SKIPS, PROTECTED, assertionCount, checkArtifactName, checkConfigPlacement,
  checkCoverage, checkDeletedTests, checkEmptySteps, checkGateOrder, checkHygiene, checkProtected,
  checkRunnerFilters, checkShellScript, checkSkips, checkTestContent, checkWorkflow, collect, isProtectedTestPath,
  maskShell, runAll, runBlocks, testNames,
} from './guard.mjs'

// The guard reads this file too. Text it bans (an or-true, a skipped test) is assembled from halves here,
// so the fixtures below are never mistaken for the real thing.
const glue = (...parts) => parts.join('')
const OR_TRUE = glue('|', '| true')
const OR_COLON = glue('|', '| :')
const DOT_SKIP = glue('.sk', 'ip')
const DOT_ONLY = glue('.on', 'ly')
const DOT_TODO = glue('.to', 'do')
const lines = findings => findings.map(f => f.line)

// ───────────────────────────── files.mjs: the ownership table ─────────────────────────────

test('each language maps to its linter steps, plus the two that read every text file', () => {
  const owners = (path, first) => ownersOf(path, first).filter(s => !EVERY_TEXT.includes(s))
  assert.deepEqual(owners('backend/app/db.py'), ['ruff', 'pyright'])
  assert.deepEqual(owners('backend/app/types.pyi'), ['ruff', 'pyright'])
  for (const p of ['desktop/src/main.js', 'ops/profile.mjs', 'a/b.cjs', 'frontend/src/App.jsx', 'desktop/scripts/ee2-goldens.spec.ts', 'a/b.tsx']) {
    assert.deepEqual(owners(p), ['eslint'], p)
  }
  assert.deepEqual(owners('frontend/src/styles.css'), ['stylelint'])
  assert.deepEqual(owners('frontend/index.html'), ['html'])
  assert.deepEqual(owners('ops/deploy-web.sh'), ['shell'])
  assert.deepEqual(owners('backend/Dockerfile'), ['docker'])
  assert.deepEqual(owners('ops/feedback-bot/Dockerfile.opener'), ['docker'])
  assert.deepEqual(owners('.github/workflows/release-desktop-win.yml'), ['actions', 'yaml'])
  assert.deepEqual(owners('docker-compose.yml'), ['yaml'])
  assert.deepEqual(owners('.github/dependabot.yml'), ['yaml'])
  assert.deepEqual(owners('desktop/package.json'), ['json'])
  assert.deepEqual(owners('a/rows.ndjson'), ['json'])
  assert.deepEqual(owners('ops/lint/.markdownlint-cli2.jsonc'), ['json'])
  assert.deepEqual(owners('docs/dev-notes.md'), ['markdown'])
  assert.deepEqual(owners('desktop/build/installer.nsh'), ['installer'])
  assert.deepEqual(owners('ops/lint/installer-check.nsi'), ['installer'])
  assert.deepEqual(ownersOf('backend/app/db.py'), ['ruff', 'pyright', 'typos', 'editorconfig'])
})

test('config text and dotfiles are read by typos and editorconfig only', () => {
  for (const p of ['ops/lint/ruff.toml', 'frontend/nginx.conf', 'a/b.ini', '.gitignore', '.gitattributes',
    '.env.example', 'backend/.dockerignore', '.editorconfig', 'ops/lint/shellcheckrc', 'ops/lint/tool-versions']) {
    assert.deepEqual(ownersOf(p), ['typos', 'editorconfig'], p)
  }
})

test('a shebang gives an extensionless script its owner', () => {
  assert.equal(interpreterOf('#!/bin/bash'), 'bash')
  assert.equal(interpreterOf('#!/usr/bin/env bash'), 'bash')
  assert.equal(interpreterOf('#!/usr/bin/env -S node --no-warnings'), 'node')
  assert.equal(interpreterOf('#!/usr/bin/env python3.12'), 'python')
  assert.equal(interpreterOf('plain text'), '')
  assert.deepEqual(ownersOf('ops/tool', '#!/bin/bash'), ['shell', 'typos', 'editorconfig'])
  assert.deepEqual(ownersOf('ops/tool', '#!/usr/bin/env python3'), ['ruff', 'pyright', 'typos', 'editorconfig'])
  assert.deepEqual(ownersOf('ops/tool', '#!/usr/bin/env node'), ['eslint', 'typos', 'editorconfig'])
  assert.deepEqual(ownersOf('ops/tool', '#!/usr/bin/perl'), [])
})

test('generated upstream code and byte-exact data are not linted, each for a stated reason', () => {
  for (const p of ['desktop/src/vendor/ee2-query/vendor/bundle.cjs', 'desktop/src/vendor/ee2-query/data/trade/stats.json',
    'backend/tests/fixtures/mods/stackable.html', 'ops/feedback-bot/tests/fixtures/alloc.py', 'backend/tests/golden/a.json',
    'desktop/test/goldens/ee2-query/a.json', 'frontend/test/goldens/regex-number.json', 'frontend/src/data/regex/pools/tablet.txt']) {
    assert.equal(typeof notLinted(p), 'string', p)
    assert.deepEqual(ownersOf(p), [], p)
    assert.equal(classify(p).kind, 'not-linted', p)
  }
  // the shims, entry.js and index.js beside the generated code are ours
  assert.equal(notLinted('desktop/src/vendor/ee2-query/index.js'), null)
  assert.equal(notLinted('desktop/src/vendor/ee2-query/shims/config.js'), null)
  // a file merely named like a fixture folder is still linted
  assert.equal(notLinted('desktop/test/fixtures.test.mjs'), null)
  for (const row of NOT_LINTED) assert.equal(row.reason.length > 10, true)
})

test('classify tells owned code, data and unknown files apart', () => {
  assert.equal(classify('backend/app/db.py').kind, 'owned')
  for (const p of ['docs/screenshots/a.png', 'desktop/build/icon.ico', 'desktop/build/icon.icns', 'frontend/public/sounds/a.m4a',
    'a/seed.gz', 'a/index.bin', 'a/key.pem', 'desktop/src/feedback/owner-key.pub', 'backend/requirements.txt',
    'a/sealed.arb', 'a/pub.b64', 'desktop/src/vendor/ee2-query/LICENSE.EE2', 'desktop/src/vendor/ee2-query/NOTICE']) {
    assert.equal(classify(p).kind, 'data', p)
  }
  assert.equal(classify('ops/thing.rb').kind, 'unknown')
  assert.equal(classify('ops/thing').kind, 'unknown')
  assert.equal(classify('ops/notes.txt', '#!/usr/bin/perl').kind, 'unknown')
  assert.equal(DATA_EXT.includes('sqlite'), false)   // nothing tracked has it: a new kind must be decided, not assumed
})

test('listFor filters a file list to one step and refuses a step it does not know', () => {
  const files = [{ path: 'a.py', firstLine: '' }, { path: 'b.sh', firstLine: '' }, { path: 'bin/run', firstLine: '#!/bin/sh' },
    { path: 'x/fixtures/c.py', firstLine: '' }, { path: 'img.png', firstLine: '' }]
  assert.deepEqual(listFor('ruff', files), ['a.py'])
  assert.deepEqual(listFor('shell', files), ['b.sh', 'bin/run'])
  assert.deepEqual(listFor('typos', files), ['a.py', 'b.sh', 'bin/run'])
  assert.throws(() => listFor('rufff', files), /unknown lint step/)
  for (const step of ['ruff', 'pyright', 'eslint', 'stylelint', 'html', 'shell', 'docker', 'actions', 'yaml', 'json',
    'markdown', 'installer', 'typos', 'editorconfig']) assert.equal(STEP_NAMES.includes(step), true, step)
})

// ───────────────────────────── 1. coverage ─────────────────────────────

test('coverage: a code file or shebang script nobody lints fails', () => {
  const found = checkCoverage([
    { path: 'backend/app/db.py', firstLine: '' },
    { path: 'docs/a.png', firstLine: '' },
    { path: 'backend/tests/fixtures/x.rb', firstLine: '' },
    { path: 'ops/thing.rb', firstLine: '' },
    { path: 'ops/tool', firstLine: '#!/usr/bin/perl' },
    { path: 'ops/mystery', firstLine: 'hello' },
  ])
  assert.deepEqual(found.map(f => f.path), ['ops/thing.rb', 'ops/tool', 'ops/mystery'])
  for (const f of found) {
    assert.match(f.what, /^no linter covers this file/)
    assert.equal(f.what.endsWith(ASK), true)
  }
})

test('coverage: a step left with no file fails, because it would pass by checking nothing', () => {
  const found = checkEmptySteps([{ path: 'a.py', firstLine: '' }])
  assert.equal(found.some(f => /"ruff"/.test(f.what)), false)
  assert.equal(found.some(f => /"stylelint"/.test(f.what)), true)
  assert.equal(found.every(f => f.path === 'ops/lint/files.mjs' && f.what.endsWith(ASK)), true)
})

// ───────────────────────────── 2. lint config placement ─────────────────────────────

test('config: a lint config or ignore file outside ops/lint fails', () => {
  const bad = ['eslint.config.mjs', 'frontend/.eslintrc.json', '.eslintignore', 'desktop/.oxlintrc.json', 'biome.json',
    'biome.jsonc', '.prettierrc', 'frontend/.prettierrc.yaml', '.prettierignore', 'frontend/tsconfig.json',
    'desktop/tsconfig.build.json', 'jsconfig.json', 'knip.json', 'knip.ts', '.stylelintrc.json', 'stylelint.config.mjs',
    '.stylelintignore', 'pyproject.toml', 'backend/ruff.toml', '.ruff.toml', 'setup.cfg', 'tox.ini', '.flake8',
    'backend/pyrightconfig.json', 'mypy.ini', '.shellcheckrc', '.hadolint.yaml', '.yamllint', '.yamllint.yml',
    '.markdownlint.jsonc', '.markdownlint-cli2.jsonc', '.lycheeignore', 'lychee.toml', 'typos.toml', '_typos.toml',
    '.typos.toml', '.ecrc', '.editorconfig-checker.json', '.gitleaks.toml', '.github/zizmor.yml', 'osv-scanner.toml',
    '.pre-commit-config.yaml', 'backend/pytest.ini', 'frontend/.editorconfig']
  for (const p of bad) {
    const found = checkConfigPlacement([p])
    assert.equal(found.length, 1, p)
    assert.equal(found[0].what.endsWith(ASK), true, p)
  }
})

test('config: ops/lint holds the configs, the root .editorconfig is the one exception, build configs are not lint', () => {
  const fine = ['ops/lint/eslint.config.mjs', 'ops/lint/ruff.toml', 'ops/lint/pyrightconfig.json', 'ops/lint/tsconfig.frontend.json',
    'ops/lint/zizmor.yml', 'ops/lint/typos.toml', '.editorconfig', 'frontend/vite.config.js', 'frontend/vitest.config.js',
    'ops/feedback-bot/tests/conftest.py', 'frontend/package.json', '.gitignore', 'backend/.dockerignore', 'docs/knip.md',
    '.github/dependabot.yml', 'docker-compose.yml', 'backend/requirements.txt']
  assert.deepEqual(checkConfigPlacement(fine), [])
})

test('config: a baseline or secret-scanner ignore list fails even inside ops/lint', () => {
  assert.equal(checkConfigPlacement(['ops/lint/eslint-suppressions.json']).length, 1)
  assert.equal(checkConfigPlacement(['ops/lint/.gitleaksignore']).length, 1)
  assert.equal(checkConfigPlacement(['eslint-suppressions.json', '.gitleaksignore']).length, 2)
})

// ───────────────────────────── 3. swallowed failures ─────────────────────────────

test('maskShell blanks comments and quoted text but keeps commands, including those inside "$( )"', () => {
  const src = [
    `echo "a ${OR_TRUE}"   # b ${OR_TRUE}`,
    `x=$(run ${OR_TRUE})`,
    `y="$(run ${OR_TRUE})"`,
    `echo 'c ${OR_TRUE}' "\${#arr[@]}" $#`,
  ].join('\n')
  const { code, bare } = maskShell(src)
  assert.equal(code.length, src.length)
  const kept = code.split('\n').map(l => l.includes(OR_TRUE))
  assert.deepEqual(kept, [false, true, true, false])
  assert.equal(bare.split('\n')[0].includes(`a ${OR_TRUE}`), true)    // strings stay in `bare`
  assert.equal(bare.split('\n')[0].includes('# b'), false)            // comments do not
  assert.equal(code.split('\n')[3].trimEnd().endsWith('$#'), true)    // $# is not a comment
})

test('shell: the first command must be set -euo pipefail', () => {
  const ok = '#!/bin/bash\n# what this does\n\nset -euo pipefail\ncd /tmp\n'
  assert.deepEqual(checkShellScript('ops/a.sh', ok), [])
  assert.deepEqual(checkShellScript('ops/a.sh', '#!/bin/bash\nset -euo pipefail   # strict\n'), [])
  const late = checkShellScript('ops/a.sh', '#!/bin/bash\ncd /tmp\nset -euo pipefail\n')
  assert.deepEqual(lines(late), [2])
  assert.match(late[0].what, /set -euo pipefail/)
  assert.equal(late[0].what.endsWith(ASK), true)
  assert.equal(checkShellScript('ops/a.sh', '#!/bin/bash\nset -eu\n').length, 1)
  assert.equal(checkShellScript('ops/a.sh', '#!/bin/bash\nset -uo pipefail\n').length, 1)
  assert.equal(checkShellScript('ops/a.sh', '#!/bin/bash\n# only a comment\n').length, 1)
})

test('shell: ops/t0-check.sh dispatches on exit codes, so it must have exactly set -uo pipefail', () => {
  assert.deepEqual(checkShellScript('ops/t0-check.sh', '#!/bin/bash\nset -uo pipefail\n'), [])
  const found = checkShellScript('ops/t0-check.sh', '#!/bin/bash\nset -euo pipefail\n')
  assert.equal(found.length, 1)
  assert.match(found[0].what, /set -uo pipefail/)
})

test('shell: every way of swallowing a failure is caught, as a command', () => {
  const head = '#!/bin/bash\nset -euo pipefail\n'
  const bad = [
    `gh release download ${OR_TRUE}`,
    `rel=$(curl -fsS "$API" 2>/dev/null ${OR_TRUE})`,
    `echo "$(cat f ${OR_TRUE})"`,
    `shift ${OR_COLON}`,
    `[ -n "$x" ] && rm "$x" ${glue('|', '|true')}`,
    `cmd ${glue('|', '| /bin/true')}`,
    'set +e',
    'set +eu',
    'set +o errexit',
    'set +o pipefail',
    `if x; then y ${OR_TRUE}; fi`,
  ]
  for (const src of bad) {
    const found = checkShellScript('ops/a.sh', head + src + '\n')
    assert.equal(found.length, 1, src)
    assert.equal(found[0].line, 3, src)
    assert.match(found[0].what, /swallows a failure/, src)
    assert.equal(found[0].what.endsWith(ASK), true, src)
  }
})

test('shell: comments, quoted text and stderr redirects are left alone', () => {
  const head = '#!/bin/bash\nset -euo pipefail\n'
  const clean = [
    `# never write cmd ${OR_TRUE}`,
    `echo "do not append ${OR_TRUE}"`,
    `echo 'set +e is banned'   # set +e`,
    'grep -q x f 2>/dev/null',
    'cmd || { echo "FATAL"; exit 1; }',
    'cmd || echo "WARN: carried on"',
    'set -e',
    'set +x',
    'reset +e',
    glue('a |', '| truthy'),
  ]
  for (const src of clean) assert.deepEqual(checkShellScript('ops/a.sh', head + src + '\n'), [], src)
})

test('shell: a heredoc body is read as it stands, so a remote script cannot swallow either', () => {
  const src = [
    '#!/bin/bash', 'set -euo pipefail',
    `ssh host bash -s <<'REMOTE'`,
    `it's a remote script`,
    `curl x ${OR_TRUE}`,
    'REMOTE',
    'echo done',
  ].join('\n')
  assert.deepEqual(lines(checkShellScript('ops/a.sh', src)), [5])
})

test('runBlocks finds inline and block run: scripts with their line numbers', () => {
  const yml = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: npm ci',
    '      - name: two',
    '        run: |',
    '          cd desktop',
    '          npm test',
    '      - uses: actions/checkout@v7',
  ].join('\n')
  assert.deepEqual(runBlocks(yml).map(b => [b.line, b.text]), [[4, 'npm ci'], [7, '          cd desktop\n          npm test']])
})

test('workflow: swallowed failures, continue-on-error, if: false and a direct PyInstaller call fail', () => {
  const yml = [
    'jobs:',                                                    // 1
    '  a:',                                                     // 2
    '    continue-on-error: true',                              // 3
    '    steps:',                                               // 4
    `      - run: npm audit ${OR_TRUE}`,                        // 5
    '      - name: Build bundled backend (PyInstaller)',        // 6
    '        if: false',                                        // 7
    '        run: |',                                           // 8
    '          set +e',                                         // 9
    '          # pyinstaller is called by the script below',    // 10
    '          python -m PyInstaller app.spec',                 // 11
    '      - run: pyinstaller app.spec',                        // 12
    '      - if: ${{ false }}',                                 // 13
    '        run: echo hi',                                     // 14
  ].join('\n')
  const found = checkWorkflow('.github/workflows/a.yml', yml)
  assert.deepEqual(lines(found).sort((a, b) => a - b), [3, 5, 7, 9, 11, 12, 13])
  assert.equal(found.every(f => f.what.endsWith(ASK)), true)
})

test('workflow: the real shape passes (script call, names and comments that mention PyInstaller)', () => {
  const yml = [
    '# PyInstaller cannot cross-compile',
    'jobs:',
    '  build-win:',
    '    steps:',
    '      - name: Build bundled backend + sidecar (PyInstaller, Windows x64)',
    '        if: github.event_name == \'workflow_dispatch\'',
    '        run: PY=python bash desktop/build-backend.sh',
    '      - run: |',
    '          [ -f "$f" ] && FILES+=("$f")',
    '          echo "exit code: $?" 2>/dev/null',
  ].join('\n')
  assert.deepEqual(checkWorkflow('.github/workflows/a.yml', yml), [])
})

// ───────────────────────────── 4. gate ordering ─────────────────────────────

test('gate order: run-tests.sh must come before the first remote command', () => {
  const ok = [
    '#!/bin/bash', '# tests → rsync backend', 'set -euo pipefail',
    'HOST="${SHAZAM_HOST:-shazam@host}"',
    '[ "$(git branch --show-current)" = "main" ] || exit 1',
    'echo "about to rsync and ssh"',
    './ops/run-tests.sh',
    'rsync -az a "$HOST:b"',
    'sshshazambom sudo ls',
    'git push origin main',
  ].join('\n')
  assert.deepEqual(checkGateOrder('ops/deploy-web.sh', ok), [])
})

test('gate order: each kind of remote command ahead of the gate fails on its own line', () => {
  for (const cmd of ['rsync -az a b', 'ssh "$HOST" true', 'sshshazambom sudo ls', 'gh workflow run x.yml',
    'RID=$(gh run list)', 'git push origin main', 'git tag v1', 'node scripts/sync-ee2.mjs ${EE2_TAG:+--tag "$EE2_TAG"}']) {
    const src = ['#!/bin/bash', 'set -euo pipefail', cmd, '../ops/run-tests.sh', 'echo ok'].join('\n')
    const found = checkGateOrder('desktop/publish-github.sh', src)
    assert.deepEqual(lines(found), [3], cmd)
    assert.match(found[0].what, /before the test gate/, cmd)
    assert.equal(found[0].what.endsWith(ASK), true, cmd)
  }
})

test('gate order: a script that never runs the gate, or only names it, fails', () => {
  const never = checkGateOrder('ops/deploy-web.sh', '#!/bin/bash\nset -euo pipefail\nrsync -az a b\n')
  assert.equal(never.length >= 1, true)
  assert.equal(never.some(f => /never runs/.test(f.what)), true)
  const named = ['#!/bin/bash', 'set -euo pipefail', 'echo "run ./ops/run-tests.sh yourself"', '# ./ops/run-tests.sh',
    'if false; then', '  ./ops/run-tests.sh', 'fi', 'echo deployed'].join('\n')
  assert.equal(checkGateOrder('ops/deploy-web.sh', named).some(f => /never runs/.test(f.what)), true)
})

test('artifact name: the Windows installer name may not contain a space', () => {
  const pkg = name => JSON.stringify({ build: { nsis: { artifactName: name } } }, null, 2)
  assert.deepEqual(checkArtifactName('desktop/package.json', pkg('${productName}-Setup-${version}.${ext}')), [])
  const spaced = checkArtifactName('desktop/package.json', pkg('${productName} Setup ${version}.${ext}'))
  assert.equal(spaced.length, 1)
  assert.equal(spaced[0].line, 4)
  assert.equal(spaced[0].what.endsWith(ASK), true)
  // electron-builder's default name has spaces, so a missing name fails too
  assert.equal(checkArtifactName('desktop/package.json', JSON.stringify({ build: { nsis: {} } })).length, 1)
  assert.equal(checkArtifactName('desktop/package.json', '{ not json').length, 1)
})

// ───────────────────────────── 5. test protection ─────────────────────────────

test('tests: which paths are tests, goldens and fixtures', () => {
  for (const p of ['backend/tests/test_db.py', 'backend/tests/_proddb.py', 'backend/tests/golden/a.json',
    'backend/tests/fixtures/mods/a.html.gz', 'desktop/test/a.test.mjs', 'desktop/test/goldens/ee2-query/a.json',
    'frontend/test/lifecycle/a.test.jsx', 'frontend/test/workspace-store.fuzzy.mjs', 'desktop/scripts/ee2-goldens.spec.ts',
    'ops/lint/guard.test.mjs', 'ops/lint/test_json_check.py', 'ops/feedback-bot/tests/conftest.py']) {
    assert.equal(isProtectedTestPath(p), true, p)
  }
  for (const p of ['backend/app/db.py', 'frontend/src/lib/price.js', 'docs/testing.md', 'ops/lint/guard.mjs']) {
    assert.equal(isProtectedTestPath(p), false, p)
  }
})

test('tests: a test, golden or fixture file at the base that is gone now fails', () => {
  const basePaths = ['backend/tests/test_a.py', 'backend/tests/golden/a.json', 'desktop/test/fixtures/x.txt', 'backend/app/old.py']
  const found = checkDeletedTests({ basePaths, nowPaths: ['backend/tests/test_a.py'] })
  assert.deepEqual(found.map(f => f.path), ['backend/tests/golden/a.json', 'desktop/test/fixtures/x.txt'])
  assert.equal(found.every(f => f.what.endsWith(ASK)), true)
})

test('tests: names are read from Python and JavaScript test files', () => {
  const py = 'def test_a():\n    pass\n\nclass TestX:\n    async def test_b(self):\n        pass\n    def test_a(self): ...\ndef helper(): ...\n'
  assert.deepEqual([...testNames('backend/tests/test_x.py', py)], [['test_a', 2], ['test_b', 1]])
  const js = `test('adds', () => {})\n  it("subtracts things", async () => {})\ntest(\`templated\`, () => {})\ndescribe('group', () => {})\nlatest('no')\n`
  assert.deepEqual([...testNames('desktop/test/a.test.mjs', js).keys()], ['adds', 'subtracts things', 'templated'])
})

test('tests: a removed or renamed test name fails and is listed', () => {
  const base = 'def test_a():\n    assert 1\n\ndef test_b():\n    assert 2\n'
  const now = 'def test_a():\n    assert 1\n\ndef test_c():\n    assert 2\n'
  const found = checkTestContent('backend/tests/test_x.py', base, now)
  assert.equal(found.length, 1)
  assert.match(found[0].what, /test_b/)
  assert.equal(found[0].what.endsWith(ASK), true)
  assert.deepEqual(checkTestContent('backend/tests/test_x.py', base, base + '\ndef test_d():\n    assert 3\n'), [])
  const jsBase = `test('one', () => { assert.equal(1, 1) })\ntest('two', () => { assert.equal(2, 2) })\n`
  const jsNow = `test('one', () => { assert.equal(1, 1); assert.equal(2, 2) })\n`
  assert.match(checkTestContent('desktop/test/a.test.mjs', jsBase, jsNow)[0].what, /two/)
})

test('tests: the number of assertions in a test file may not drop', () => {
  assert.equal(assertionCount('backend/tests/test_x.py', 'assert a\n    assert b, "msg"\nx = assertion\n# assert in a comment\n'), 2)
  assert.equal(assertionCount('desktop/test/a.test.mjs', 'assert.equal(a, b)\nassert(ok)\nexpect(x).toBe(1)\nassertNever()\n'), 3)
  const base = 'def test_a():\n    assert x == 1\n    assert y == 2\n'
  const now = 'def test_a():\n    assert x == 1\n'
  const found = checkTestContent('backend/tests/test_x.py', base, now)
  assert.equal(found.length, 1)
  assert.match(found[0].what, /2 to 1/)
  assert.equal(found[0].what.endsWith(ASK), true)
})

test('tests: every Python skip outside the pinned sites fails', () => {
  const bad = [
    glue('    pytest', DOT_SKIP, '("not today")'),
    glue('@pytest.mark', DOT_SKIP, '(reason="x")'),
    '@pytest.mark.skipif(sys.platform == "win32", reason="x")',
    '@pytest.mark.xfail',
    '    pytest.xfail("known")',
    'np = pytest.importorskip("numpy")',
    'pytestmark = pytest.mark.skipif(True, reason="x")',
    glue('@unittest', DOT_SKIP, '("x")'),
    '        self.skipTest("x")',
    '    raise unittest.SkipTest("x")',
    'collect_ignore = ["test_slow.py"]',
    'collect_ignore_glob = ["*_slow.py"]',
    'def pytest_ignore_collect(collection_path): return True',
  ]
  for (const src of bad) {
    const found = checkSkips('backend/tests/test_x.py', `import pytest\n${src}\n`)
    assert.equal(found.length, 1, src)
    assert.equal(found[0].line, 2, src)
    assert.equal(found[0].what.endsWith(ASK), true, src)
  }
  const clean = ['# they skip where that DB is absent', '    assert lh.is_skipped_league(name), f"should skip {name!r}"',
    'skip_hours = 12', '    """Rows we skip refetching for 12 hours."""']
  for (const src of clean) assert.deepEqual(checkSkips('backend/tests/test_x.py', src + '\n'), [], src)
})

test('tests: the pinned skip sites pass only in their file and with their guarding line', () => {
  assert.equal(PINNED_SKIPS.length, 2)
  for (const pin of PINNED_SKIPS) {
    const rows = [...pin.lines, ...pin.after]
    const body = rows.map(l => '    ' + l).join('\n') + '\n'
    assert.deepEqual(checkSkips(pin.path, body), [], pin.path)
    // the lines after the skip call hold its condition or reason: loosening them breaks the pin
    const loosened = [...pin.lines, ...pin.after.map((l, k) => (k === 0 ? 'True,' : l))].map(l => '    ' + l).join('\n') + '\n'
    assert.equal(checkSkips(pin.path, loosened).length, 1, pin.path)
    assert.equal(checkSkips('backend/tests/test_other.py', body).length, 1, pin.path)
    const unguarded = '    ' + pin.lines.at(-1) + '\n'
    assert.equal(checkSkips(pin.path, unguarded).length, 1, pin.path)
    assert.equal(pin.why.length > 10, true)
  }
  assert.deepEqual(PINNED_SKIPS.map(p => p.path), ['backend/tests/_proddb.py', 'ops/feedback-bot/tests/test_sandbox.py'])
})

test('tests: every JavaScript skip, focus and todo fails', () => {
  const bad = [
    glue('test', DOT_SKIP, `('later', () => {})`),
    glue('test', DOT_ONLY, `('this one', () => {})`),
    glue('test', DOT_TODO, `('write me')`),
    glue('it', DOT_SKIP, `('later', () => {})`),
    glue('describe', DOT_ONLY, `('group', () => {})`),
    glue('test', DOT_SKIP, 'If(isMac)', `('x', () => {})`),
    glue(`test('x', { sk`, `ip: true }, () => {})`),
    glue(`test('x', { to`, `do: 'later' }, () => {})`),
    glue(`test('x', (t) => { t`, DOT_SKIP, `('no') })`),
    glue('x', `it('later', () => {})`),
    glue('x', `describe('group', () => {})`),
    glue(`test('x', {\n  sk`, `ip: process.platform === 'darwin',\n}, () => {})`),
  ]
  for (const src of bad) {
    const found = checkSkips('desktop/test/a.test.mjs', `import test from 'node:test'\n${src}\n`)
    assert.equal(found.length, 1, src)
    assert.equal(found[0].line === 2 || found[0].line === 3, true, src)
    assert.equal(found[0].what.endsWith(ASK), true, src)
  }
  // prose inside a message is not an option: these three are real lines from the repo's tests
  const clean = [`test('skips nothing', () => {})`, 'const skipped = rows.filter(r => !r.ok)', `exit('done')`,
    'const onlyOne = list[0]', `assert.equal(row.todos, 3)`,
    `assert.match(line, /x/, 'stable only: a beta needs no notes')`,
    `test('a tier comes from the tier name only: the game prints tiers on the other scale', () => {})`,
    `assert.equal(rows[0].k, 1, 'Rotund (46) only: Virile is above 50')`, 'const pick = ok ? skip : keep']
  for (const src of clean) assert.deepEqual(checkSkips('frontend/test/a.test.mjs', src + '\n'), [], src)
  // product code is not read: a cursor there may have a method of that name
  assert.deepEqual(checkSkips('frontend/src/lib/a.js', glue('cursor', DOT_SKIP, '(2)\n')), [])
})

test('tests: the gate scripts may not filter which tests run', () => {
  const bad = [
    '"$PY" -m pytest tests -q -k "not slow"',
    '"$PY" -m pytest tests -q --deselect tests/test_a.py::test_b',
    '"$PY" -m pytest tests -q --ignore=tests/test_slow.py',
    '( cd backend && "$PY" -m pytest tests \\\n    -q -k prod )',
    'node --test --test-name-pattern="fast" "desktop/test/*.test.mjs"',
    'node --test --test-skip-pattern="slow" "desktop/test/*.test.mjs"',
    'node --test --test-only "desktop/test/*.test.mjs"',
    'npx vitest run --exclude test/lifecycle/slow.test.jsx',
    'npx vitest run -t "board"',
  ]
  for (const src of bad) {
    const found = checkRunnerFilters('ops/tests.sh', `#!/bin/bash\nset -euo pipefail\n${src}\n`)
    assert.equal(found.length, 1, src)
    assert.equal(found[0].line, 3, src)
    assert.equal(found[0].what.endsWith(ASK), true, src)
  }
  const clean = ['"$PY" -m pytest tests -q -p no:cacheprovider', 'node --test "frontend/test/*.test.mjs"',
    '# pytest -k prod runs the owner replays', 'npm ci --ignore-scripts', 'rsync -az --exclude=dist a b', 'ls -k', 'tar -t -f a.tar']
  for (const src of clean) assert.deepEqual(checkRunnerFilters('ops/tests.sh', `#!/bin/bash\n${src}\n`), [], src)
  const pkg = JSON.stringify({ scripts: { 'test:ui': 'vitest run -t board' } }, null, 2)
  assert.equal(checkRunnerFilters('frontend/package.json', pkg).length, 1)
  assert.deepEqual(checkRunnerFilters('frontend/package.json', JSON.stringify({ scripts: { 'test:ui': 'vitest run' } }, null, 2)), [])
})

// ───────────────────────────── 6. protected paths ─────────────────────────────

test('protected: on main any difference from origin/main fails; on a branch it is a notice', () => {
  assert.deepEqual(PROTECTED, ['ops/lint/', 'ops/lint.sh', 'ops/tests.sh', 'ops/audit.sh', 'ops/run-tests.sh',
    '.editorconfig', 'frontend/scripts/lint-style.mjs'])
  const changed = ['ops/lint/ruff.toml', 'ops/lint/new-untracked.mjs', 'ops/run-tests.sh', '.editorconfig',
    'frontend/scripts/lint-style.mjs', 'backend/app/db.py', 'ops/linting-notes.md', 'frontend/.editorconfig']
  const onMain = checkProtected({ branch: 'main', changed })
  assert.deepEqual(onMain.findings.map(f => f.path), changed.slice(0, 5))
  assert.equal(onMain.findings.every(f => f.what === 'Lint configuration differs from origin/main. Only the owner changes lint rules: stop and ask.'), true)
  assert.deepEqual(onMain.notices, [])
  const onBranch = checkProtected({ branch: 'lint/strict-linters', changed })
  assert.deepEqual(onBranch.findings, [])
  assert.deepEqual(onBranch.notices.map(n => n.path), changed.slice(0, 5))
  assert.deepEqual(checkProtected({ branch: 'main', changed: ['backend/app/db.py'] }), { findings: [], notices: [] })
})

// ───────────────────────────── 7. hygiene ─────────────────────────────

test('hygiene: a shell script without its executable bit fails', () => {
  const file = (path, mode, firstLine = '') => ({ path, firstLine, size: 10, mode })
  const found = checkHygiene({ files: [file('ops/a.sh', 0o100644), file('ops/b.sh', 0o100755), file('bin/run', 0o100644, '#!/bin/bash'),
    file('ops/c.py', 0o100644)], baseSizes: new Map() })
  assert.deepEqual(found.map(f => f.path), ['ops/a.sh', 'bin/run'])
  assert.equal(found.every(f => /executable/.test(f.what) && f.what.endsWith(ASK)), true)
})

test('hygiene: a file over 500,000 bytes fails outside the pinned paths', () => {
  const file = (path, size) => ({ path, firstLine: '', size, mode: 0o100644 })
  assert.deepEqual(BIG_FILE_ALLOWED, ['desktop/src/vendor/ee2-query/data/', 'docs/screenshots/', 'frontend/test/goldens/', 'desktop/build/icon.icns'])
  const found = checkHygiene({ files: [file('docs/big.png', 500_001), file('docs/ok.png', 500_000), file('docs/screenshots/a.png', 2_000_000),
    file('desktop/src/vendor/ee2-query/data/en/items.ndjson', 1_700_000), file('frontend/test/goldens/a.json', 700_000),
    file('desktop/build/icon.icns', 740_000), file('desktop/build/icon.icns.bak', 740_000)], baseSizes: new Map() })
  assert.deepEqual(found.map(f => f.path), ['docs/big.png', 'desktop/build/icon.icns.bak'])
  assert.equal(found.every(f => f.what.endsWith(ASK)), true)
})

test('hygiene: a new JSON file over 50,000 bytes fails, because game tables are not hand-listed in the repo', () => {
  const file = (path, size) => ({ path, firstLine: '', size, mode: 0o100644 })
  const baseSizes = new Map([['frontend/src/data/old-big.json', 60_000], ['frontend/src/data/grew.json', 40_000]])
  const found = checkHygiene({ files: [
    file('frontend/src/data/items.json', 50_001), file('frontend/src/data/small.json', 50_000),
    file('frontend/src/data/old-big.json', 70_000), file('frontend/src/data/grew.json', 60_000),
    file('desktop/package-lock.json', 150_000), file('ops/lint/package-lock.json', 240_000),
    file('backend/tests/fixtures/lump.json', 98_000), file('desktop/src/vendor/ee2-query/data/trade/items.json', 186_000),
  ], baseSizes })
  assert.deepEqual(found.map(f => f.path), ['frontend/src/data/items.json', 'frontend/src/data/grew.json'])
  assert.equal(found.every(f => /Game data/.test(f.what) && f.what.endsWith(ASK)), true)
})

// ───────────────────────────── collect + runAll: git through one injected function ─────────────────────────────

function fakeRepo({ branch = 'feature', baseMissing = false } = {}) {
  const now = {
    'backend/app/db.py': 'x = 1\n',
    'backend/tests/test_a.py': 'def test_a():\n    assert 1\n',
    'ops/a.sh': '#!/bin/bash\nset -euo pipefail\necho hi\n',
    'ops/lint/guard.mjs': '// guard\n',
    'ops/odd.rb': 'puts 1\n',
  }
  const base = {
    'backend/app/db.py': 'x = 0\n',
    'backend/tests/test_a.py': 'def test_a():\n    assert 1\n\ndef test_gone():\n    assert 2\n',
    'backend/tests/test_deleted.py': 'def test_z():\n    assert 1\n',
    'ops/a.sh': '#!/bin/bash\nset -euo pipefail\necho hi\n',
  }
  const calls = []
  const git = args => {
    calls.push(args.join(' '))
    const [cmd] = args
    if (cmd === 'ls-files' && args.includes('-co')) return Object.keys(now).concat('backend/removed-from-disk.py').join('\0') + '\0'
    if (cmd === 'ls-files') return 'ops/lint/guard.mjs\0ops/odd.rb\0'
    if (cmd === 'rev-parse' && baseMissing) throw new Error('unknown revision')
    if (cmd === 'rev-parse') return 'abc123\n'
    if (cmd === 'ls-tree') return Object.entries(base).map(([p, t]) => `100644 blob aaaa ${String(t.length).padStart(7)}\t${p}`).join('\0') + '\0'
    if (cmd === 'diff') return 'backend/app/db.py\0backend/tests/test_a.py\0backend/tests/test_deleted.py\0'
    if (cmd === 'branch') return branch + '\n'
    if (cmd === 'show') return base[args[1].split(':').slice(1).join(':')]
    throw new Error('unexpected git ' + args.join(' '))
  }
  const io = {
    head: path => (path in now ? now[path].split('\n')[0] : null),
    read: path => now[path],
    stat: path => ({ size: now[path].length, mode: path.endsWith('.sh') ? 0o100755 : 0o100644 }),
  }
  return { git, io, calls }
}

test('collect reads git only through the injected function, against origin/main unless a test passes another base', () => {
  assert.equal(BASE, 'origin/main')
  const { git, io, calls } = fakeRepo()
  const state = collect({ git, io })
  assert.deepEqual(state.files.map(f => f.path), ['backend/app/db.py', 'backend/tests/test_a.py', 'ops/a.sh', 'ops/lint/guard.mjs', 'ops/odd.rb'])
  assert.equal(state.branch, 'feature')
  assert.equal(state.baseOk, true)
  assert.equal(state.baseSizes.get('backend/tests/test_deleted.py'), 27)
  assert.equal(state.changed.includes('ops/lint/guard.mjs'), true)     // untracked files count as changed
  assert.equal(calls.some(c => c.includes('origin/main')), true)
  const other = fakeRepo()
  collect({ git: other.git, io: other.io, base: 'some/ref' })
  assert.equal(other.calls.some(c => c.includes('origin/main')), false)
  assert.equal(other.calls.some(c => c.includes('some/ref')), true)
})

test('runAll reports each check under its own name', () => {
  const { git, io } = fakeRepo()
  const { sections, notices } = runAll(collect({ git, io }))
  const by = Object.fromEntries(sections.map(s => [s.name, s.findings]))
  assert.deepEqual(Object.keys(by), ['coverage', 'lint config', 'swallowed failures', 'gate order', 'test protection', 'protected paths', 'hygiene'])
  assert.equal(by.coverage.some(f => f.path === 'ops/odd.rb'), true)
  assert.deepEqual(by['swallowed failures'], [])
  assert.equal(by['test protection'].some(f => f.path === 'backend/tests/test_deleted.py'), true)
  assert.equal(by['test protection'].some(f => f.path === 'backend/tests/test_a.py' && /test_gone/.test(f.what)), true)
  assert.deepEqual(by['protected paths'], [])
  assert.deepEqual(notices.map(n => n.path), ['ops/lint/guard.mjs'])
  // the two deploy scripts and desktop/package.json must exist: their absence is a finding, not a pass
  assert.equal(by['gate order'].some(f => f.path === 'ops/deploy-web.sh'), true)
  assert.equal(by['gate order'].some(f => f.path === 'desktop/package.json'), true)
})

test('runAll fails the protected paths on main, and fails closed when origin/main cannot be read', () => {
  const main = fakeRepo({ branch: 'main' })
  const onMain = runAll(collect({ git: main.git, io: main.io }))
  assert.deepEqual(onMain.sections.find(s => s.name === 'protected paths').findings.map(f => f.path), ['ops/lint/guard.mjs'])
  const gone = fakeRepo({ baseMissing: true })
  const state = collect({ git: gone.git, io: gone.io })
  assert.equal(state.baseOk, false)
  const res = runAll(state)
  for (const name of ['test protection', 'protected paths']) {
    const f = res.sections.find(s => s.name === name).findings
    assert.equal(f.length >= 1, true, name)
    assert.match(f[0].what, /origin\/main/, name)
  }
})
