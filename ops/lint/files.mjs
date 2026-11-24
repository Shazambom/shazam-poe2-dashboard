// The one ownership table: which lint step reads which file, and which files no linter parses.
//
// Every gate script builds its file list from here, and ops/lint/guard.mjs fails any code file that
// ends up with no owner, so a new kind of file cannot slip past the linters unnoticed.
//
//   node ops/lint/files.mjs <step>     # the step's files, NUL-separated (read with `read -r -d ''`)
//
// Only the owner changes this table.
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Paths no syntax-aware linter parses. The suppression scan and the secret scan still read them.
// `prefix` is a folder; `segment` is a folder name at any depth.
export const NOT_LINTED = [
  { prefix: 'desktop/src/vendor/ee2-query/vendor/', reason: 'generated upstream code, hashed by the EE2 manifest' },
  { prefix: 'desktop/src/vendor/ee2-query/data/', reason: 'generated upstream data, hashed by the EE2 manifest' },
  { segment: 'fixtures', reason: 'test fixtures are byte-exact inputs' },
  { prefix: 'backend/tests/golden/', reason: 'goldens are byte-exact expected output' },
  { prefix: 'desktop/test/goldens/', reason: 'goldens are byte-exact expected output' },
  { prefix: 'frontend/test/goldens/', reason: 'goldens are byte-exact expected output' },
  { prefix: 'frontend/src/data/regex/', reason: 'byte-exact regex data, compared by its golden test' },
]

// A row owns a path when its `prefix` (if any) matches and one of `ext`, `name` or `interpreters`
// (the shebang's program) matches. A path can match several rows; it gets every step of each.
export const OWNERS = [
  { steps: ['ruff', 'pyright'], ext: ['py', 'pyi'], interpreters: ['python'] },
  { steps: ['tsc'], name: /\.d\.ts$/ },
  { steps: ['eslint'], ext: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'], excludeName: /\.d\.ts$/, interpreters: ['node'] },
  { steps: ['stylelint'], ext: ['css'] },
  { steps: ['html'], ext: ['html'] },
  { steps: ['shell'], ext: ['sh', 'bash'], interpreters: ['sh', 'bash'] },
  { steps: ['docker'], name: /^Dockerfile(?:\..+)?$/ },
  { steps: ['actions'], prefix: '.github/workflows/', ext: ['yml', 'yaml'] },
  { steps: ['yaml'], ext: ['yml', 'yaml'] },
  { steps: ['json'], ext: ['json', 'ndjson', 'jsonc'] },
  { steps: ['markdown'], ext: ['md'] },
  { steps: ['installer'], ext: ['nsh', 'nsi'] },
  // Config text with no linter of its own: read by the EVERY_TEXT steps only.
  { steps: [], ext: ['toml', 'ini', 'conf', 'cfg'] },
  { steps: [], name: /^\.[^.].*$/ },                                            // dotfiles
  { steps: [], prefix: 'ops/lint/', name: /^(?:shellcheckrc|tool-versions)$/ },
]

// Spelling and whitespace are checked on every owned file, whatever its language.
export const EVERY_TEXT = ['typos', 'editorconfig']

// Files that are not code: binary, or plain data no linter has a grammar for. Decided from what the
// repo tracks. An extension in neither table fails the guard: decide where a new kind belongs.
// Plain-text data files are still read by EVERY_TEXT (typos and editorconfig).
export const DATA_TEXT_EXT = ['txt', 'pub']
export const DATA_EXT = ['png', 'ico', 'icns', 'm4a', 'gz', 'bin', 'pem', 'pub', 'txt', 'arb', 'b64']
export const DATA_NAME = /^(?:LICENSE|NOTICE)(?:\.[\w-]+)?$/

export const STEP_NAMES = [...new Set([...OWNERS.flatMap(row => row.steps), ...EVERY_TEXT])]

const baseOf = path => path.split('/').pop()
const extOf = base => (base.lastIndexOf('.') > 0 ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '')

/** Why no linter parses this path, or null when it is linted like any other. */
export function notLinted(path) {
  const dirs = path.split('/').slice(0, -1)
  const row = NOT_LINTED.find(r => (r.prefix ? path.startsWith(r.prefix) : dirs.includes(r.segment)))
  return row ? row.reason : null
}

/** The program a `#!` line runs, without its version: 'bash', 'python', 'node'. '' when there is no shebang. */
export function interpreterOf(firstLine = '') {
  if (!firstLine.startsWith('#!')) return ''
  const words = firstLine.slice(2).trim().split(/\s+/)
  let program = baseOf(words.shift() ?? '')
  if (program === 'env') program = baseOf(words.find(w => !w.startsWith('-') && !w.includes('=')) ?? '')
  return program.replace(/[\d.]+$/, '')
}

function matchingRows(path, firstLine) {
  const base = baseOf(path)
  const ext = extOf(base)
  const program = interpreterOf(firstLine)
  return OWNERS.filter(row => {
    if (row.prefix && !path.startsWith(row.prefix)) return false
    if (row.excludeName && row.excludeName.test(base)) return false
    return Boolean((row.ext && row.ext.includes(ext)) || (row.name && row.name.test(base))
      || (program && row.interpreters && row.interpreters.includes(program)))
  })
}

/**
 * What a path is to the linters:
 *   { kind: 'not-linted', steps: [], reason }   generated or byte-exact
 *   { kind: 'owned', steps: [...] }             read by these steps
 *   { kind: 'data', steps: [...] }              binary (steps: []) or plain-text data (EVERY_TEXT)
 *   { kind: 'unknown', steps: [], reason }      nobody decided: the guard fails it
 */
export function classify(path, firstLine = '') {
  const reason = notLinted(path)
  if (reason) return { kind: 'not-linted', steps: [], reason }
  const rows = matchingRows(path, firstLine)
  if (rows.length) return { kind: 'owned', steps: [...new Set([...rows.flatMap(row => row.steps), ...EVERY_TEXT])] }
  const program = interpreterOf(firstLine)
  if (program) return { kind: 'unknown', steps: [], reason: `a script for "${program}", which no linter reads` }
  const base = baseOf(path)
  const ext = extOf(base)
  if (DATA_TEXT_EXT.includes(ext) || DATA_NAME.test(base)) return { kind: 'data', steps: [...EVERY_TEXT] }
  if (DATA_EXT.includes(ext)) return { kind: 'data', steps: [] }
  return { kind: 'unknown', steps: [], reason: ext ? `the extension .${ext} has no linter` : 'no extension and no shebang' }
}

/** The lint steps that read this path. `firstLine` finds the owner of an extensionless script. */
export function ownersOf(path, firstLine = '') {
  return classify(path, firstLine).steps
}

/** The paths one step reads, from a list of { path, firstLine }. An unknown step throws: a typo must not lint nothing. */
export function listFor(step, files) {
  if (!STEP_NAMES.includes(step)) throw new Error(`unknown lint step "${step}" (known: ${STEP_NAMES.join(', ')})`)
  return files.filter(f => ownersOf(f.path, f.firstLine).includes(step)).map(f => f.path)
}

/** The first line of a file, or null when it is gone from the work tree or is a directory. */
export function headOf(file) {
  let fd
  try { fd = openSync(file, 'r') } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return null
    throw e
  }
  try {
    const buf = Buffer.alloc(256)
    const n = readSync(fd, buf, 0, 256, 0)
    return buf.toString('utf8', 0, n).split('\n')[0]
  } catch (e) {
    if (e.code === 'EISDIR') return null
    throw e
  } finally { closeSync(fd) }
}

/** Every tracked and untracked-but-not-ignored file that exists, as { path, firstLine }. */
export function repoFiles(root) {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--deduplicate', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 })
  const files = []
  for (const path of out.split('\0').filter(Boolean)) {
    const firstLine = headOf(resolve(root, path))
    if (firstLine !== null) files.push({ path, firstLine })
  }
  return files
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const steps = process.argv.slice(2)
  if (steps.length !== 1 || !STEP_NAMES.includes(steps[0])) {
    console.error(`usage: node ops/lint/files.mjs <step>   (steps: ${STEP_NAMES.join(', ')})`)
    process.exitCode = 2
    return
  }
  const paths = listFor(steps[0], repoFiles(root))
  if (!paths.length) {
    console.error(`✖ lint step "${steps[0]}" owns no file, so it would pass by checking nothing.`)
    process.exitCode = 1
    return
  }
  process.stdout.write(paths.map(p => p + '\0').join(''))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
