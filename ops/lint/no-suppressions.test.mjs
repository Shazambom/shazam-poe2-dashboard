import test from 'node:test'
import assert from 'node:assert/strict'
import { EXEMPT, kindOf, scanText } from './no-suppressions.mjs'

const hits = (path, text) => scanText(path, text).map(f => f.what)

test('every Python bypass is caught', () => {
  const cases = [
    'import x  # noqa', 'import x  # noqa: E402', 'import x  #noqa:F401', '# ruff: noqa', '# flake8: noqa',
    'x = f()  # type: ignore', 'x = f()  # type: ignore[arg-type]', '# pyright: ignore[reportFoo]', '# pyright: basic',
    '# mypy: ignore-errors', '# pylint: disable=broad-except', 'x = 1  # pyre-ignore[7]',
    'subprocess.run(c, shell=True)  # nosec B602', '# fmt: off', 'x = [1,2]  # fmt: skip', 'import b  # isort: skip',
    'if TYPE_CHECKING:  # pragma: no cover', 'x = 1  # nosemgrep', 'x = 1  # nosem: rule-id',
    '# ruff: ignore[E501]', '# ruff: file-ignore[F401]', '# ruff: disable[E741]', '# ruff: isort: skip_file',
    'x = f()  # basedpyright: ignore', '# black: off', '# autopep8: off', '# NOSONAR',
  ]
  for (const src of cases) assert.equal(hits('backend/app/a.py', src).length >= 1, true, src)
})

test('every JavaScript bypass is caught', () => {
  const cases = [
    '}, [])  // eslint-disable-line', '// eslint-disable-next-line react-hooks/exhaustive-deps', '/* eslint-disable */',
    '/* eslint no-console: "off" */', '/* eslint-env node */', '/* global window */', '// oxlint-disable-next-line',
    '// biome-ignore lint/suspicious/noExplicitAny: because', '// @ts-ignore', '// @ts-expect-error', '// @ts-nocheck',
    '// prettier-ignore', '/* istanbul ignore next */', '/* c8 ignore start */', '/* v8 ignore next */', '// knip-ignore',
    '/* exported helper */', '/** @public */', '/** @knipignore */',
  ]
  for (const src of cases) assert.equal(hits('frontend/src/a.jsx', src).length >= 1, true, src)
})

test('CSS, shell, Docker and YAML bypasses are caught', () => {
  assert.deepEqual(hits('frontend/src/styles.css', '/* stylelint-disable-next-line */'), ['stylelint-disable'])
  assert.deepEqual(hits('frontend/index.html', '<!-- [html-validate-disable-next void-style] -->'), ['html-validate disable'])
  assert.deepEqual(hits('frontend/src/styles.css', 'a { color: #fff; } /* style-ok: one-off */'), ['style-lint escape marker'])
  assert.deepEqual(hits('ops/x.sh', '# shellcheck disable=SC2086'), ['shellcheck disable'])
  assert.deepEqual(hits('backend/Dockerfile', '# hadolint ignore=DL3008'), ['hadolint ignore'])
  assert.deepEqual(hits('ops/feedback-bot/Dockerfile.bot', '# hadolint global ignore=DL3008'), ['hadolint ignore'])
  assert.deepEqual(hits('.github/workflows/a.yml', '# yamllint disable-line rule:line-length'), ['yamllint disable'])
  assert.deepEqual(hits('.github/workflows/a.yml', 'uses: a/b@v1 # zizmor: ignore[unpinned-uses]'), ['zizmor ignore'])
  assert.deepEqual(hits('ops/x.sh', 'KEY=abc # gitleaks:allow'), ['secret-scanner allow'])
  assert.deepEqual(hits('ops/x.sh', 'KEY=abc # betterleaks:allow'), ['secret-scanner allow'])
  assert.deepEqual(hits('ops/x.sh', '# shellcheck source=/dev/null'), ['shellcheck disable'])
  assert.deepEqual(hits('ops/x.sh', '# editorconfig-checker-disable-line'), ['editorconfig-checker disable'])
  assert.deepEqual(hits('desktop/build/x.nsi', '; editorconfig-checker-disable-file'), ['editorconfig-checker disable'])
  assert.deepEqual(hits('backend/app/a.py', 'x = f()  # ty: ignore[arg]'), ['type-checker ignore'])
  assert.deepEqual(hits('backend/app/a.py', 'x = f()  # pyrefly: ignore'), ['type-checker ignore'])
})

test('an extensionless script is scanned when it has a shebang', () => {
  assert.equal(kindOf('ops/tool', '#!/bin/bash'), 'code')
  assert.equal(kindOf('ops/notes', 'plain text'), null)
})

test('Markdown may name code markers, but not switch off its own linters', () => {
  assert.deepEqual(hits('docs/a.md', 'Never write `# noqa` or `eslint-disable`.'), [])
  assert.deepEqual(hits('docs/a.md', '<!-- markdownlint-disable MD013 -->'), ['markdownlint inline configuration'])
  assert.deepEqual(hits('docs/a.md', '<!-- cspell:disable -->'), ['spell-check suppression'])
})

test('ordinary code that merely looks similar is left alone', () => {
  const clean = [
    ['backend/app/a.py', 'ignore_types = ["x"]  # the types to ignore'],
    ['backend/app/a.py', 'def test_global_state(): ...'],
    ['frontend/src/a.js', 'const v8 = ignore ? 1 : 2'],
    ['frontend/src/a.js', '/* globally shared cache */'],
    ['frontend/src/a.js', "const style = ok ? 'a' : 'b'"],
    ['ops/x.sh', 'echo "shellcheck passed"'],
  ]
  for (const [path, src] of clean) assert.deepEqual(hits(path, src), [], src)
})

test('data and binary files are not scanned; only generated upstream code is exempt', () => {
  assert.equal(kindOf('desktop/test/goldens/a.json'), null)
  assert.equal(kindOf('desktop/src/vendor/ee2-query/vendor/query.cjs'), null)
  assert.equal(kindOf('desktop/src/vendor/ee2-query/data/en/client_strings.mjs'), null)
  // shims, entry.js and index.js under ee2-query are ours (PROVENANCE.md), so they are scanned
  assert.equal(kindOf('desktop/src/vendor/ee2-query/shims/config.js'), 'code')
  assert.equal(kindOf('desktop/src/vendor/ee2-query/index.js'), 'code')
  assert.equal(kindOf('desktop/src/main.js'), 'code')
  assert.deepEqual(EXEMPT, ['desktop/src/vendor/ee2-query/vendor/', 'desktop/src/vendor/ee2-query/data/',
    'ops/lint/no-suppressions.mjs', 'ops/lint/no-suppressions.test.mjs'])
})

test('findings carry the file, the 1-based line and the source', () => {
  assert.deepEqual(scanText('backend/app/a.py', 'a = 1\nimport b  # noqa: E402\n'),
    [{ path: 'backend/app/a.py', line: 2, what: 'ruff/flake8 noqa', src: 'import b  # noqa: E402' }])
})
