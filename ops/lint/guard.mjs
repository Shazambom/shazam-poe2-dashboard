// Repo checks no single linter can make: that every file has a linter, that lint config lives in one
// place, that scripts do not swallow failures, that the deploy scripts run the gate before anything
// remote, that tests are not quietly removed or skipped, and that lint rules change only with the owner.
//
//   node ops/lint/guard.mjs      # exits 1 on any finding
//
// It takes no arguments and reads no environment variable: there is no way to weaken a check.
// Each check is a pure function over data (tested in guard.test.mjs); main() reads git and the disk.
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STEP_NAMES, classify, headOf, listFor, notLinted, ownersOf } from './files.mjs'

export const ASK = 'If the rule is wrong for this code, stop and ask the owner.'
/** Tests and protected paths are compared with this ref. Only a test passes another one to collect(). */
export const BASE = 'origin/main'

const baseOf = path => path.split('/').pop()
const lineAt = (text, index) => text.slice(0, index).split('\n').length

// ───────────────────────────── 1. coverage ─────────────────────────────

/** A code file or shebang script that no lint step owns and no not-linted row names. */
export function checkCoverage(files) {
  const found = []
  for (const { path, firstLine } of files) {
    const c = classify(path, firstLine)
    if (c.kind !== 'unknown') continue
    found.push({ path, what: `no linter covers this file (${c.reason}). Give it an extension a linter owns, or delete it if nothing needs it. Do not edit ops/lint/files.mjs yourself. ${ASK}` })
  }
  return found
}

/** A step whose file list is empty passes by checking nothing. */
export function checkEmptySteps(files) {
  return STEP_NAMES.filter(step => listFor(step, files).length === 0).map(step => ({
    path: 'ops/lint/files.mjs',
    what: `lint step "${step}" owns no file, so it would pass by checking nothing. Restore the files it reads. ${ASK}`,
  }))
}

// ───────────────────────────── 2. lint config placement ─────────────────────────────

// Basenames a linter, formatter or test runner discovers on its own. One of these outside ops/lint/
// changes the rules for its folder without touching the protected configs.
export const LINT_CONFIG_NAMES = [
  /^eslint\.config\.(?:js|cjs|mjs|ts|cts|mts)$/, /^\.eslintrc(?:\..+)?$/, /^\.eslintignore$/,
  /^\.oxlintrc(?:\..+)?$/, /^biome\.jsonc?$/,
  /^\.prettierrc(?:\..+)?$/, /^prettier\.config\.(?:js|cjs|mjs|ts)$/, /^\.prettierignore$/,
  /^tsconfig(?:\..+)?\.json$/, /^jsconfig\.json$/, /^\.?knip\.(?:json|jsonc|js|cjs|mjs|ts)$/,
  /^\.stylelintrc(?:\..+)?$/, /^stylelint\.config\.(?:js|cjs|mjs|ts)$/, /^\.stylelintignore$/,
  /^\.htmlvalidate\.(?:json|js|cjs|mjs)$/,
  /^pyproject\.toml$/, /^\.?ruff\.toml$/, /^setup\.cfg$/, /^tox\.ini$/, /^\.flake8$/,
  /^pyrightconfig\.json$/, /^\.?mypy\.ini$/, /^pytest\.ini$/,
  /^\.shellcheckrc$/, /^\.hadolint\.ya?ml$/, /^\.yamllint(?:\..+)?$/, /^\.?zizmor\.ya?ml$/,
  /^\.markdownlint.*$/, /^\.lycheeignore$/, /^lychee\.toml$/, /^[._]?typos\.toml$/,
  /^\.ecrc$/, /^\.editorconfig-checker\.json$/, /^\.gitleaks\.toml$/, /^osv-scanner\.toml$/,
  /^\.pre-commit-config\.ya?ml$/,
]
// A baseline or an ignore list for findings is a bypass wherever it lives, ops/lint/ included.
export const BASELINE_NAMES = [/^eslint-suppressions\.json$/, /^\.gitleaksignore$/]
const LINT_DIR = 'ops/lint/'

/** Lint config files anywhere but ops/lint/. The root .editorconfig is the one exception. */
export function checkConfigPlacement(paths) {
  const found = []
  for (const path of paths) {
    const base = baseOf(path)
    if (BASELINE_NAMES.some(re => re.test(base))) {
      found.push({ path, what: `a lint baseline or ignore list. Delete it and fix the findings it hides. ${ASK}` })
    } else if (base === '.editorconfig') {
      if (path !== base) found.push({ path, what: `a nested .editorconfig. Delete it: the root .editorconfig is the only one. ${ASK}` })
    } else if (!path.startsWith(LINT_DIR) && LINT_CONFIG_NAMES.some(re => re.test(base))) {
      found.push({ path, what: `a lint config outside ops/lint/. Delete it: every linter reads its one config from ops/lint/. ${ASK}` })
    }
  }
  return found
}

// ───────────────────────────── 3. swallowed failures ─────────────────────────────

const blank = ch => (ch === '\n' ? '\n' : ' ')
const HEREDOC = /^<<(-?)[ \t]*(?:(['"])([A-Za-z_][\w.-]*)\2|\\?([A-Za-z_][\w.-]*))/

/**
 * Two same-length copies of a shell script, so a pattern matches commands and not prose:
 *   code — comments and quoted text blanked; commands inside "$( )" and backticks kept
 *   bare — comments blanked only
 * A heredoc body is kept as it stands (it is usually a script for another shell), minus its `#` lines.
 */
export function maskShell(text) {
  const code = []
  const bare = []
  const put = (ch, inCode, inBare) => { code.push(inCode ? ch : blank(ch)); bare.push(inBare ? ch : blank(ch)) }
  const stack = [{ kind: 'code', depth: 0 }]
  let heredocs = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const top = stack.at(-1)
    if (top.kind === 'dq') {
      if (ch === '\\') {
        put(ch, false, true)
        if (i + 1 < text.length) { put(text[i + 1], false, true) }
        i += 2
        continue
      }
      if (ch === '"') { stack.pop(); put(ch, true, true); i += 1; continue }
      if (ch === '$' && text[i + 1] === '(') { put('$', true, true); put('(', true, true); stack.push({ kind: 'code', depth: 0, sub: true }); i += 2; continue }
      if (ch === '`') { put(ch, true, true); stack.push({ kind: 'code', depth: 0, tick: true }); i += 1; continue }
      put(ch, false, true); i += 1; continue
    }
    if (ch === '\n' && heredocs.length) {
      put(ch, true, true); i += 1
      for (const doc of heredocs) {
        let j = i
        let end = -1
        while (j < text.length) {
          const eol = text.indexOf('\n', j)
          const line = text.slice(j, eol === -1 ? text.length : eol)
          if ((doc.dash ? line.replace(/^\t+/, '') : line) === doc.tag) { end = eol === -1 ? text.length : eol; break }
          if (eol === -1) break
          j = eol + 1
        }
        if (end === -1) continue                       // no terminator: it was not a heredoc after all
        for (const line of text.slice(i, end).split('\n').map((l, k, all) => (k < all.length - 1 ? l + '\n' : l))) {
          const keep = !line.trimStart().startsWith('#')
          for (const c of line) put(c, keep, keep)
        }
        i = end
      }
      heredocs = []
      continue
    }
    if (ch === '\\') {
      put(ch, true, true)
      if (i + 1 < text.length) { put(text[i + 1], true, true) }
      i += 2
      continue
    }
    if (ch === "'") {
      const ansi = text[i - 1] === '$'
      put(ch, true, true); i += 1
      while (i < text.length && text[i] !== "'") {
        if (ansi && text[i] === '\\' && i + 1 < text.length) { put(text[i], false, true); i += 1 }
        put(text[i], false, true); i += 1
      }
      if (i < text.length) { put(text[i], true, true); i += 1 }
      continue
    }
    if (ch === '"') { put(ch, true, true); stack.push({ kind: 'dq' }); i += 1; continue }
    if (ch === '`') {
      put(ch, true, true); i += 1
      if (top.tick) stack.pop(); else stack.push({ kind: 'code', depth: 0, tick: true })
      continue
    }
    if (ch === '$' && text[i + 1] === '(') { put('$', true, true); put('(', true, true); stack.push({ kind: 'code', depth: 0, sub: true }); i += 2; continue }
    if (ch === '(') { top.depth += 1; put(ch, true, true); i += 1; continue }
    if (ch === ')') {
      if (top.depth > 0) top.depth -= 1; else if (top.sub) stack.pop()
      put(ch, true, true); i += 1; continue
    }
    if (ch === '#' && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
      while (i < text.length && text[i] !== '\n') { put(text[i], false, false); i += 1 }
      continue
    }
    if (ch === '<' && text[i + 1] === '<' && text[i + 2] !== '<' && text[i - 1] !== '<') {
      const m = HEREDOC.exec(text.slice(i, i + 200))
      if (m) {
        heredocs.push({ tag: m[3] ?? m[4], dash: m[1] === '-' })
        for (const c of m[0]) put(c, true, true)
        i += m[0].length
        continue
      }
    }
    put(ch, true, true); i += 1
  }
  return { code: code.join(''), bare: bare.join('') }
}

// An `||` whose right-hand side always succeeds, or a `set` that turns errexit or pipefail off.
const SWALLOWS = [
  /\|\|\s*(?:(?:\/usr)?\/bin\/)?(?:true|:)(?=$|[\s;)}&|])/gm,
  /(?<![\w-])set\s+\+[a-df-zA-Z]*e[a-zA-Z]*(?![\w-])/g,
  /(?<![\w-])set\s+\+o\s+(?:errexit|pipefail)(?![\w-])/g,
]

/** Swallowed failures in shell text: [{ line, what }], lines counted from `firstLine`. */
function findSwallows(text, firstLine = 1) {
  const { code } = maskShell(text)
  const found = []
  for (const re of SWALLOWS) {
    for (const m of code.matchAll(re)) {
      found.push({
        line: firstLine + lineAt(code, m.index) - 1,
        what: `\`${m[0].replace(/\s+/g, ' ')}\` swallows a failure. Delete it and handle the failing case in the open: test for it with \`if\`, or let the script stop. ${ASK}`,
      })
    }
  }
  return found.sort((a, b) => a.line - b.line)
}

// Scripts that dispatch on a command's exit code cannot run under errexit. One entry, set by the owner.
export const EXIT_CODE_DISPATCH = ['ops/t0-check.sh']

/** A shell script: strict mode before the first command, and no swallowed failure. */
export function checkShellScript(path, text) {
  const want = EXIT_CODE_DISPATCH.includes(path) ? 'set -uo pipefail' : 'set -euo pipefail'
  const why = EXIT_CODE_DISPATCH.includes(path) ? ' exactly (it dispatches on exit codes)' : ''
  const found = []
  const rows = text.split('\n')
  const first = rows.findIndex((row, i) => !(i === 0 && row.startsWith('#!')) && row.trim() && !row.trim().startsWith('#'))
  const command = first === -1 ? '' : rows[first].replace(/\s+#.*$/, '').trim()
  if (command !== want) {
    found.push({ path, line: first === -1 ? 1 : first + 1, what: `the first command must be \`${want}\`${why}. Put it before every other command. ${ASK}` })
  }
  for (const f of findSwallows(text)) found.push({ path, ...f })
  return found
}

/** The shell scripts in a workflow: [{ line, text }], `line` being the script's first line in the file. */
export function runBlocks(yaml) {
  const rows = yaml.split('\n')
  const blocks = []
  for (let i = 0; i < rows.length; i += 1) {
    const m = /^(\s*)(-\s+)?run\s*:(.*)$/.exec(rows[i])
    if (!m) continue
    const rest = m[3].trim()
    const keyIndent = m[1].length + (m[2] ? m[2].length : 0)
    if (/^[|>][+-]?\d*\s*(?:#.*)?$/.test(rest)) {
      let j = i + 1
      while (j < rows.length && (!rows[j].trim() || rows[j].search(/\S/) > keyIndent)) j += 1
      while (j > i + 1 && !rows[j - 1].trim()) j -= 1
      blocks.push({ line: i + 2, text: rows.slice(i + 1, j).join('\n') })
      i = j - 1
    } else if (rest) {
      blocks.push({ line: i + 1, text: rest })
    }
  }
  return blocks
}

/** A workflow: no swallowed failure in a run script, no step switched off or allowed to fail, no direct PyInstaller. */
export function checkWorkflow(path, text) {
  const found = []
  const rows = text.split('\n')
  const inScript = new Set()
  for (const block of runBlocks(text)) {
    const scriptRows = block.text.split('\n')
    scriptRows.forEach((_, k) => inScript.add(block.line + k))
    for (const f of findSwallows(block.text, block.line)) found.push({ path, ...f })
    maskShell(block.text).bare.split('\n').forEach((row, k) => {
      if (!/pyinstaller/i.test(row)) return
      found.push({ path, line: block.line + k, what: `a workflow runs PyInstaller directly. Call desktop/build-backend.sh or desktop/build-sidecar.sh: both platforms build with the same scripts. ${ASK}` })
    })
  }
  rows.forEach((row, i) => {
    // an inline `run: cmd` shares its line with the key, so only block-script lines are skipped here
    if (row.trim().startsWith('#') || (inScript.has(i + 1) && !/^\s*(?:-\s+)?run\s*:/.test(row))) return
    if (/^\s*(?:-\s+)?continue-on-error\s*:/.test(row)) {
      found.push({ path, line: i + 1, what: `\`continue-on-error\` lets a failed step pass. Delete the line. ${ASK}` })
    }
    if (/^\s*(?:-\s+)?if\s*:\s*(?:\$\{\{\s*)?['"]?false\b/.test(row)) {
      found.push({ path, line: i + 1, what: `\`if: false\` switches this off without removing it. Delete the line, or delete what it guards. ${ASK}` })
    }
  })
  return found.sort((a, b) => a.line - b.line)
}

// ───────────────────────────── 4. gate ordering ─────────────────────────────

export const GATED_SCRIPTS = ['ops/deploy-web.sh', 'desktop/publish-github.sh']
const WORD = '(?<![\\w./$-])'
const REMOTE = [
  new RegExp(`${WORD}(?:rsync|ssh|sshshazambom)(?![\\w.-])`),
  new RegExp(`${WORD}gh\\s`),
  new RegExp(`${WORD}git\\s+(?:push|tag)(?![\\w-])`),
  new RegExp(`${WORD}node\\s+scripts/sync-ee2\\.mjs`),
]
// The gate counts only as an unindented command of its own: not inside an `if`, a function or a string.
const GATE = /^(?:(?:exec|bash)\s+)?["']?[\w.${}/-]*run-tests\.sh["']?\s*$/

/** A deploy script must run ops/run-tests.sh before its first remote command or EE2 sync. */
export function checkGateOrder(path, text) {
  const { code, bare } = maskShell(text)
  const bareRows = bare.split('\n')
  const gate = bareRows.findIndex(row => GATE.test(row.trimEnd()))
  const found = []
  if (gate === -1) {
    found.push({ path, what: `this script never runs ops/run-tests.sh as an unindented command of its own. Add that line before the first command that touches a remote. ${ASK}` })
  }
  code.split('\n').forEach((row, i) => {
    if (gate !== -1 && i >= gate) return
    const hit = REMOTE.map(re => re.exec(row)).find(Boolean)
    if (!hit) return
    found.push({ path, line: i + 1, what: `\`${hit[0].trim()}\` runs before the test gate. Move the run-tests.sh line above it, so a red test stops the script before anything remote or generated. ${ASK}` })
  })
  return found
}

/** GitHub rewrites spaces in asset names to dots and the updater then 404s. */
export function checkArtifactName(path, text) {
  let pkg
  try { pkg = JSON.parse(text) } catch (e) {
    return [{ path, what: `not valid JSON (${e.message}), so build.nsis.artifactName cannot be checked. Fix the file. ${ASK}` }]
  }
  const name = pkg?.build?.nsis?.artifactName
  const at = text.split('\n').findIndex(row => row.includes('"artifactName"'))
  const line = at === -1 ? undefined : at + 1
  if (typeof name !== 'string') {
    return [{ path, line, what: `build.nsis.artifactName is missing, and electron-builder's default name has spaces. Set a space-free name. ${ASK}` }]
  }
  if (/\s/.test(name)) {
    return [{ path, line, what: `build.nsis.artifactName "${name}" contains a space: GitHub rewrites it to a dot and the updater cannot find the installer. Use hyphens. ${ASK}` }]
  }
  return []
}

// ───────────────────────────── 5. test protection ─────────────────────────────

const TEST_DIRS = ['test', 'tests', '__tests__']
const DATA_DIRS = ['fixtures', 'golden', 'goldens']
const PY_EXT = /\.pyi?$/
const JS_EXT = /\.(?:js|mjs|cjs|jsx|ts|tsx)$/

/** 'py' or 'js' for a file holding test code, else null. Fixtures and goldens are data, not test code. */
export function testKind(path) {
  if (notLinted(path)) return null
  const base = baseOf(path)
  const inTestDir = path.split('/').slice(0, -1).some(dir => TEST_DIRS.includes(dir))
  if (PY_EXT.test(base)) return inTestDir || /^(?:test_.*|.*_test|conftest)\.py$/.test(base) ? 'py' : null
  if (JS_EXT.test(base)) return inTestDir || /\.(?:test|spec)\.[a-z]+$/.test(base) ? 'js' : null
  return null
}

/** A test, a test helper, a golden or a fixture: a file whose removal weakens the tests. */
export function isProtectedTestPath(path) {
  if (testKind(path)) return true
  return path.split('/').slice(0, -1).some(dir => TEST_DIRS.includes(dir) || DATA_DIRS.includes(dir))
}

/** Test, golden and fixture files tracked at the base and missing now. */
export function checkDeletedTests({ basePaths, nowPaths }) {
  const now = new Set(nowPaths)
  return basePaths.filter(p => isProtectedTestPath(p) && !now.has(p)).map(path => ({
    path,
    what: `this test, golden or fixture file is in ${BASE} and missing here. Restore it (\`git checkout ${BASE} -- ${path}\`). ${ASK}`,
  }))
}

/** Test names in a file, with how often each occurs: Python `def test_*`, JavaScript `test(`/`it(` titles. */
export function testNames(path, text) {
  const kind = testKind(path)
  const re = kind === 'py'
    ? /^[ \t]*(?:async[ \t]+)?def[ \t]+(test_\w+)[ \t]*\(/gm
    : /(?<![\w.$])(?:test|it)\s*\(\s*(?:'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`)/g
  const names = new Map()
  if (!kind) return names
  for (const m of text.matchAll(re)) {
    const name = m[1] ?? m[2] ?? m[3]
    names.set(name, (names.get(name) ?? 0) + 1)
  }
  return names
}

/** How many assertions a test file makes: Python `assert`, JavaScript `assert(`, `assert.x(` and `expect(`. */
export function assertionCount(path, text) {
  const kind = testKind(path)
  if (kind === 'py') return [...text.matchAll(/^[ \t]*assert\b/gm)].length
  if (kind === 'js') return [...text.matchAll(/(?<![\w$.])(?:assert(?:\.\w+)?|expect)\s*\(/g)].length
  return 0
}

/** One test file against its version at the base: no test name removed, no fewer assertions. */
export function checkTestContent(path, baseText, nowText) {
  const found = []
  const now = testNames(path, nowText)
  for (const [name, count] of testNames(path, baseText)) {
    if ((now.get(name) ?? 0) >= count) continue
    found.push({ path, what: `test "${name}" is in ${BASE} and gone here. Restore it under the same name; change what it asserts only if the behaviour really changed. ${ASK}` })
  }
  const before = assertionCount(path, baseText)
  const after = assertionCount(path, nowText)
  if (after < before) {
    found.push({ path, what: `assertions dropped from ${before} to ${after} against ${BASE}. Restore the removed assertions and make the code pass them. ${ASK}` })
  }
  return found
}

// The only skips in the repo. A pin is its file plus consecutive lines (trimmed), the last being the skip
// itself and the ones before it the condition that guards it. Adding one is the owner's decision.
export const PINNED_SKIPS = [
  {
    path: 'backend/tests/_proddb.py',
    lines: ['_asked = os.environ.get("ARBITER_PROD_TESTS") == "1"', 'prod = pytest.mark.skipif(not (_asked and PROD_DB.exists()),'],
    why: "replays against the owner's own market DB are opt-in, so the deploy gate does not depend on this machine's app data",
  },
  {
    path: 'ops/feedback-bot/tests/test_sandbox.py',
    lines: ['if cell == "alloc" and sys.platform == "darwin":',
      'pytest.skip("macOS does not enforce RLIMIT_AS; the bot runs on Linux (shazam), where it does")'],
    why: 'macOS does not enforce RLIMIT_AS, so that one parametrized case cannot run on the Mac that runs the gate',
  },
]

const PY_SKIPS = [
  /\b(?:pytest|mark|unittest)\.(?:skip|skipif|skipIf|skipUnless|xfail|importorskip)\b/,
  /(?<![\w.])(?:skip|skipif|xfail|importorskip)\s*\(/,
  /\bskipTest\s*\(|\bSkipTest\b/,
  /\bcollect_ignore(?:_glob)?\b/,
  /\bpytest_ignore_collect\b/,
]
const JS_SKIPS = [
  /\.(?:only|skip|todo|skipIf|runIf)(?![\w$])/,
  /(?:[{,]\s*|^\s*)['"]?(?:skip|todo|only)['"]?\s*:/,   // an option key, not prose inside a message
  /(?<![\w$.])x(?:it|test|describe)\s*\(/,
]

/** A Python line without its trailing comment. */
function stripPyComment(row) {
  let quote = ''
  for (let i = 0; i < row.length; i += 1) {
    const ch = row[i]
    if (quote) {
      if (ch === '\\') i += 1; else if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '#') return row.slice(0, i)
  }
  return row
}

/** Skipped, focused, todo and import-skipped tests in one test file, outside the pinned sites. */
export function checkSkips(path, text) {
  const kind = testKind(path)
  if (!kind) return []
  const rows = text.split('\n')
  const found = []
  rows.forEach((row, i) => {
    const src = kind === 'py' ? stripPyComment(row) : row
    if (!(kind === 'py' ? PY_SKIPS : JS_SKIPS).some(re => re.test(src))) return
    const pinned = PINNED_SKIPS.some(pin => pin.path === path
      && pin.lines.every((want, k) => (rows[i - (pin.lines.length - 1) + k] ?? '').trim() === want))
    if (pinned) return
    found.push({ path, line: i + 1, what: `\`${row.trim().slice(0, 100)}\` skips, focuses or defers a test. Delete it and make the test run and pass here; install a missing library rather than skipping its tests. ${ASK}` })
  })
  return found
}

const FILTER_ANYWHERE = /(?<![\w-])--(?:deselect|test-name-pattern|test-skip-pattern|test-only|testNamePattern)(?![\w-])/
const FILTER_PYTEST = /(?<=\s)-k(?=[\s=]|$)|(?<![\w-])--ignore(?:-glob)?(?![\w-])/
const FILTER_VITEST = /(?<=\s)-t(?=[\s=]|$)|(?<![\w-])--exclude(?![\w-])/

/** Options that make a test runner leave tests out, in a shell script or a package.json. */
export function checkRunnerFilters(path, text) {
  const isShell = !path.endsWith('.json')
  const rows = (isShell ? maskShell(text).bare : text).split('\n')
  const found = []
  for (let i = 0; i < rows.length; i += 1) {
    const start = i
    let logical = rows[i]
    while (isShell && logical.trimEnd().endsWith('\\') && i + 1 < rows.length) { i += 1; logical = logical.trimEnd().slice(0, -1) + ' ' + rows[i] }
    const hit = FILTER_ANYWHERE.exec(logical)
      ?? (/pytest/.test(logical) ? FILTER_PYTEST.exec(logical) : null)
      ?? (/vitest/.test(logical) ? FILTER_VITEST.exec(logical) : null)
    if (!hit) continue
    found.push({ path, line: start + 1, what: `\`${hit[0]}\` makes the test runner leave tests out. Delete the option: the gate runs every test. ${ASK}` })
  }
  return found
}

// ───────────────────────────── 6. protected paths ─────────────────────────────

export const PROTECTED = ['ops/lint/', 'ops/lint.sh', 'ops/tests.sh', 'ops/audit.sh', 'ops/run-tests.sh',
  '.editorconfig', 'frontend/scripts/lint-style.mjs']
const isProtected = path => PROTECTED.some(p => (p.endsWith('/') ? path.startsWith(p) : path === p))

/** On main a changed lint path fails; on any other branch it is listed for the merge review. */
export function checkProtected({ branch, changed }) {
  const paths = changed.filter(isProtected)
  if (branch === 'main') {
    return { findings: paths.map(path => ({ path, what: `Lint configuration differs from ${BASE}. Only the owner changes lint rules: stop and ask.` })), notices: [] }
  }
  return { findings: [], notices: paths.map(path => ({ path, what: `differs from ${BASE} (lint configuration: for the owner's review at merge)` })) }
}

// ───────────────────────────── 7. hygiene ─────────────────────────────

export const BIG_FILE_BYTES = 500_000
export const BIG_FILE_ALLOWED = ['desktop/src/vendor/ee2-query/data/', 'docs/screenshots/', 'frontend/test/goldens/', 'desktop/build/icon.icns']
export const BIG_JSON_BYTES = 50_000
const num = n => n.toLocaleString('en-US')

/** Exec bits, oversized files, and new large JSON. `files`: [{ path, firstLine, size, mode }]. */
export function checkHygiene({ files, baseSizes }) {
  const found = []
  for (const { path, firstLine, size, mode } of files) {
    if (ownersOf(path, firstLine).includes('shell') && (mode & 0o111) === 0) {
      found.push({ path, what: `a shell script without its executable bit. Run \`chmod +x ${path}\`. ${ASK}` })
    }
    if (size > BIG_FILE_BYTES && !BIG_FILE_ALLOWED.some(p => (p.endsWith('/') ? path.startsWith(p) : path === p))) {
      found.push({ path, what: `${num(size)} bytes, over the ${num(BIG_FILE_BYTES)} byte limit for a file in the repo. Make it smaller or keep it out of git. ${ASK}` })
    }
    const wasBig = (baseSizes.get(path) ?? 0) > BIG_JSON_BYTES
    if (path.endsWith('.json') && size > BIG_JSON_BYTES && !wasBig && !notLinted(path) && baseOf(path) !== 'package-lock.json') {
      found.push({ path, what: `a new ${num(size)} byte JSON file, over the ${num(BIG_JSON_BYTES)} byte limit. Game data rides the market pipeline: derive it on shazam and let the seed carry it, never list it in the repo. ${ASK}` })
    }
  }
  return found
}

// ───────────────────────────── reading the repo ─────────────────────────────

const nul = out => out.split('\0').filter(Boolean)

/**
 * Everything the checks need, read once. `git(args)` returns stdout and throws on failure; it is the only
 * way git is reached, so tests pass a fake. `io` reads the work tree: head(path) → first line or null
 * when the file is gone, read(path) → text, stat(path) → { size, mode }.
 */
export function collect({ git, io, base = BASE }) {
  const files = []
  for (const path of nul(git(['ls-files', '-co', '--exclude-standard', '--deduplicate', '-z']))) {
    const firstLine = io.head(path)
    if (firstLine === null) continue
    files.push({ path, firstLine, ...io.stat(path) })
  }
  const untracked = nul(git(['ls-files', '-o', '--exclude-standard', '-z']))
  const branch = git(['branch', '--show-current']).trim()
  let baseOk = true
  let baseError = ''
  try { git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]) } catch (e) {
    baseOk = false
    baseError = e.message.split('\n')[0]
  }
  const baseSizes = new Map()
  let changed = [...untracked]
  if (baseOk) {
    for (const row of nul(git(['ls-tree', '-r', '-l', '-z', base]))) {
      const [meta, path] = row.split('\t')
      baseSizes.set(path, Number(meta.trim().split(/\s+/)[3]) || 0)
    }
    changed = [...new Set([...nul(git(['diff', '--name-only', '-z', base, '--'])), ...untracked])]
  }
  return { files, branch, base, baseOk, baseError, baseSizes, changed, read: io.read, baseRead: path => git(['show', `${base}:${path}`]) }
}

/** Every check over a collected repo: { sections: [{ name, findings }], notices }. */
export function runAll(state) {
  const { files, read } = state
  const paths = files.map(f => f.path)
  const here = new Set(paths)
  const shell = listFor('shell', files)
  const workflows = listFor('actions', files)
  const noBase = { path: state.base, what: `cannot read ${state.base} (${state.baseError}), so this check cannot run. Run \`git fetch origin main\` and try again. ${ASK}` }

  const swallowed = [
    ...shell.flatMap(p => checkShellScript(p, read(p))),
    ...workflows.flatMap(p => checkWorkflow(p, read(p))),
  ]

  const missing = path => ({ path, what: `this file is missing, so the release checks on it cannot run. Restore it. ${ASK}` })
  const gate = [
    ...GATED_SCRIPTS.flatMap(p => (here.has(p) ? checkGateOrder(p, read(p)) : [missing(p)])),
    ...(here.has('desktop/package.json') ? checkArtifactName('desktop/package.json', read('desktop/package.json')) : [missing('desktop/package.json')]),
  ]

  const tests = []
  if (state.baseOk) {
    tests.push(...checkDeletedTests({ basePaths: [...state.baseSizes.keys()], nowPaths: paths }))
    for (const p of state.changed) {
      if (!here.has(p) || !state.baseSizes.has(p) || !testKind(p)) continue
      tests.push(...checkTestContent(p, state.baseRead(p), read(p)))
    }
  } else tests.push(noBase)
  for (const p of paths) if (testKind(p)) tests.push(...checkSkips(p, read(p)))
  for (const p of [...shell, ...paths.filter(q => baseOf(q) === 'package.json')]) tests.push(...checkRunnerFilters(p, read(p)))

  const protectedPaths = state.baseOk ? checkProtected({ branch: state.branch, changed: state.changed }) : { findings: [noBase], notices: [] }

  return {
    sections: [
      { name: 'coverage', findings: [...checkCoverage(files), ...checkEmptySteps(files)] },
      { name: 'lint config', findings: checkConfigPlacement(paths) },
      { name: 'swallowed failures', findings: swallowed },
      { name: 'gate order', findings: gate },
      { name: 'test protection', findings: tests },
      { name: 'protected paths', findings: protectedPaths.findings },
      { name: 'hygiene', findings: checkHygiene({ files, baseSizes: state.baseSizes }) },
    ],
    notices: protectedPaths.notices,
  }
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 27, stdio: ['ignore', 'pipe', 'pipe'] })
  const io = {
    head: path => headOf(resolve(root, path)),
    read: path => readFileSync(resolve(root, path), 'utf8'),
    stat: path => { const s = statSync(resolve(root, path)); return { size: s.size, mode: s.mode } },
  }
  // Compare with where this branch left the base, so tests added upstream later are not read as removed here.
  let base = BASE
  try {
    base = git(['merge-base', 'HEAD', BASE]).trim() || BASE
  } catch (e) {
    console.log(`notice: no merge-base with ${BASE} (${String(e.message).split('\n')[0]}); comparing with ${BASE} itself`)
  }
  const { sections, notices } = runAll(collect({ git, io, base }))
  let total = 0
  for (const { name, findings } of sections) {
    if (!findings.length) continue
    total += findings.length
    console.log(`${name} (${findings.length})`)
    for (const f of findings) console.log(`  ✖ ${f.path}${f.line ? ':' + f.line : ''}  ${f.what}`)
    console.log('')
  }
  if (notices.length) {
    console.log(`notice: ${notices.length} lint path(s) differ from ${BASE}. On main this fails; only the owner changes lint rules.`)
    for (const n of notices) console.log(`  • ${n.path}`)
    console.log('')
  }
  if (total) {
    console.log(`✖ ${total} guard finding(s). Each line says what to change. Do not edit ops/lint/ to make one pass.`)
    process.exitCode = 1
    return
  }
  console.log('✓ guard passed')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
