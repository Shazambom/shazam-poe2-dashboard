// Verifies that ops/lint/files.mjs agrees with what every lint step script actually reads
// over git ls-files, so no owned file can silently slip past its linter.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STEP_NAMES, listFor, notLinted, repoFiles } from './files.mjs'

const LINT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(LINT_DIR, '../..')

const STEP_DRIVER = {
  ruff: 'ops/lint/python-steps.sh',
  pyright: 'ops/lint/python-steps.sh',
  eslint: 'ops/lint/js-steps.sh',
  tsc: 'ops/lint/js-steps.sh',
  stylelint: 'ops/lint/js-steps.sh',
  html: 'ops/lint/js-steps.sh',
  shell: 'ops/lint/infra-steps.sh',
  docker: 'ops/lint/infra-steps.sh',
  actions: 'ops/lint/infra-steps.sh',
  yaml: 'ops/lint/infra-steps.sh',
  json: 'ops/lint/infra-steps.sh',
  markdown: 'ops/lint/infra-steps.sh',
  installer: 'ops/lint/infra-steps.sh',
  typos: 'ops/lint/infra-steps.sh',
  editorconfig: 'ops/lint/infra-steps.sh',
}

function listStepFiles(step) {
  const script = STEP_DRIVER[step]
  assert.ok(script, `no step script registered for "${step}"`)
  const out = execFileSync('bash', [script, '--list', step], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  })
  return out.split('\0').filter(Boolean).sort()
}

test('every step in files.mjs is mapped to a step script and matches its actual file list over git ls-files', () => {
  const tracked = repoFiles(ROOT)

  for (const step of STEP_NAMES) {
    const fromTable = listFor(step, tracked).sort()
    const fromCli = execFileSync(process.execPath, ['ops/lint/files.mjs', step], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1 << 24,
    }).split('\0').filter(Boolean).sort()
    assert.deepEqual(fromCli, fromTable, `files.mjs CLI output differs from listFor("${step}")`)

    const actual = listStepFiles(step)
    if (step === 'json') {
      // json_check.py validates every owned JSON/NDJSON/JSONC file plus not-linted JSON/NDJSON
      // fixtures and goldens so syntax/duplicate-key coverage is never reduced.
      const actualOwned = actual.filter((p) => !notLinted(p))
      const actualExtra = actual.filter((p) => Boolean(notLinted(p)))
      assert.deepEqual(actualOwned, fromTable, 'json step owned files must equal files.mjs json')
      assert.ok(actualExtra.every((p) => /\.(?:json|ndjson)$/.test(p)), 'extra json files must only be not-linted .json/.ndjson')
      assert.ok(actual.includes('ops/lint/.markdownlint-cli2.jsonc'), 'json step must read ops/lint/.markdownlint-cli2.jsonc')
    } else if (step === 'tsc') {
      // tsc owns .d.ts files (which eslint does not parse) and also type-checks pilot frontend
      // JS files and desktop JS/MJS files already owned by eslint.
      const actualSet = new Set(actual)
      for (const f of fromTable) {
        assert.ok(actualSet.has(f), `tsc step must read files.mjs-owned file ${f}`)
      }
      assert.ok(actualSet.has('frontend/src/lib/desktop-bridge.d.ts'), 'tsc step must read frontend/src/lib/desktop-bridge.d.ts')
    } else {
      assert.deepEqual(actual, fromTable, `step "${step}" actual files must equal files.mjs`)
    }
  }
})

test('frontend tsconfig includes desktop-bridge.d.ts with skipLibCheck disabled so tsc genuinely checks it', () => {
  const cfgPath = resolve(LINT_DIR, 'tsconfig.frontend.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  assert.equal(cfg.compilerOptions.skipLibCheck, false, 'skipLibCheck must be false so .d.ts declarations are type-checked')
  const resolved = cfg.files.map((f) => relative(ROOT, resolve(LINT_DIR, f)).split('\\').join('/'))
  assert.ok(resolved.includes('frontend/src/lib/desktop-bridge.d.ts'))
})
