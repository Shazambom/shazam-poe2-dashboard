// The first lint in the gate: no comment may switch a lint rule off.
//
// Lint rules in this repo are obeyed, not bypassed. This runs before every other linter, so a
// suppression fails here even where the tool itself would have honoured it. There is no waiver
// file and no escape marker: fix the code, or raise the rule with the owner.
//
//   node ops/lint/no-suppressions.mjs            # scan every tracked + untracked source file
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// [pattern, what it bypasses]. `docs: true` rules also apply to Markdown; the rest do not, because
// prose legitimately names these markers.
export const RULES = [
  // Python
  [/#\s*(?:flake8\s*:\s*)?noqa\b/i, 'ruff/flake8 noqa'],
  [/#\s*ruff\s*:/i, 'inline ruff directive'],
  [/#\s*(?:type|ty|pyrefly)\s*:\s*ignore/i, 'type-checker ignore'],
  [/#\s*(?:pyright|basedpyright|mypy|pylint|pytype)\s*:/i, 'inline type-checker/pylint configuration'],
  [/#\s*pyre-(?:ignore|fixme)/i, 'pyre ignore'],
  [/#\s*nosec\b/i, 'bandit nosec'],
  [/#\s*(?:fmt|yapf|black|autopep8)\s*:\s*(?:off|on|skip)/i, 'formatter off-switch'],
  [/#\s*isort\s*:\s*(?:skip|off|on|split)/i, 'isort off-switch'],
  [/pragma\s*:\s*no\s*(?:cover|branch)/i, 'coverage exclusion'],
  // JavaScript / TypeScript
  [/eslint-(?:disable|enable)/, 'eslint-disable'],
  [/\/\*\s*eslint(?:-env)?\s/, 'inline eslint configuration'],
  [/\/\*\s*globals?\s/, 'inline eslint globals'],
  [/oxlint-(?:disable|enable)/, 'oxlint-disable'],
  [/biome-ignore/, 'biome-ignore'],
  [/@ts-(?:ignore|expect-error|nocheck)/, 'TypeScript error suppression'],
  [/prettier-ignore/, 'prettier-ignore'],
  [/\b(?:istanbul|c8|v8)\s+ignore\b/, 'coverage exclusion'],
  [/jshint\s+ignore|jscs\s*:\s*disable/, 'jshint/jscs ignore'],
  [/knip-ignore|@knipignore|\/\*\*?\s*@public\b/, 'knip ignore'],
  [/\/\*\s*exported\s/, 'inline eslint exported'],
  // CSS, shell, Docker, YAML
  [/stylelint-(?:disable|enable)/, 'stylelint-disable'],
  [/\[html-validate-(?:disable|enable)/, 'html-validate disable'],
  [/shellcheck\s+(?:disable=|source=\/dev\/null)/, 'shellcheck disable'],
  [/editorconfig-checker-disable/, 'editorconfig-checker disable'],
  [/hadolint\s+(?:global\s+)?ignore=/, 'hadolint ignore'],
  [/yamllint\s+disable/, 'yamllint disable'],
  [/zizmor\s*:\s*ignore/, 'zizmor ignore'],
  [/checkov\s*:\s*skip/, 'checkov skip'],
  // Any language
  [/\bnosem(?:grep)?\b/, 'semgrep suppression'],
  [/\bNOSONAR\b/, 'sonar suppression'],
  [/(?:git|better)leaks\s*:\s*allow|trufflehog\s*:\s*ignore|pragma\s*:\s*allowlist/, 'secret-scanner allow', { docs: true }],
  [/markdownlint-(?:disable|enable|capture|restore|configure-file)/, 'markdownlint inline configuration', { docs: true }],
  [/cspell\s*:\s*(?:disable|ignore)|codespell\s*:\s*ignore|spellchecker\s*:\s*(?:disable|off)/, 'spell-check suppression', { docs: true }],
  // This repo's own retired escape hatch for frontend/scripts/lint-style.mjs
  [/style-ok/, 'style-lint escape marker'],
].map(([re, what, opts = {}]) => ({ re, what, docs: !!opts.docs }))

// The only paths this lint does not read. Generated upstream code (hashed by the EE2 manifest) is not
// ours to edit; the shims, entry.js and index.js beside it are ours and are read. This file and its
// test must spell the markers out. Adding a path here needs the owner's say-so.
export const EXEMPT = [
  'desktop/src/vendor/ee2-query/vendor/',
  'desktop/src/vendor/ee2-query/data/',
  'ops/lint/no-suppressions.mjs',
  'ops/lint/no-suppressions.test.mjs',
]

const CODE_EXT = new Set(['py', 'pyi', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'css', 'html', 'sh', 'bash',
  'zsh', 'yml', 'yaml', 'toml', 'cfg', 'ini', 'nsh', 'nsi', 'conf', 'jsonc'])
const CODE_NAME = /^(?:Dockerfile(?:\..+)?|.*\.dockerignore|\.gitignore|\.gitattributes|\.editorconfig)$/

/** 'code', 'docs' or null (not scanned: data and binary files carry no lint directives). */
export function kindOf(path, firstLine = '') {
  if (EXEMPT.some(p => path === p || (p.endsWith('/') && path.startsWith(p)))) return null
  const base = path.split('/').pop()
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : ''
  if (ext === 'md' || ext === 'mdx') return 'docs'
  if (CODE_EXT.has(ext) || CODE_NAME.test(base)) return 'code'
  if (!ext && firstLine.startsWith('#!')) return 'code'
  return null
}

/** Every suppression in one file's text: [{ path, line, what, src }]. */
export function scanText(path, text) {
  const lines = text.split('\n')
  const kind = kindOf(path, lines[0])
  if (!kind) return []
  const found = []
  lines.forEach((src, i) => {
    for (const rule of RULES) {
      if (kind === 'docs' && !rule.docs) continue
      if (rule.re.test(src)) found.push({ path, line: i + 1, what: rule.what, src: src.trim().slice(0, 140) })
    }
  })
  return found
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 })
    .split('\0').filter(Boolean)
  const found = []
  for (const path of files) {
    let text
    try { text = readFileSync(resolve(root, path), 'utf8') } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'EISDIR') continue   // deleted in the work tree, or a submodule dir
      throw e
    }
    found.push(...scanText(path, text))
  }
  for (const f of found) console.log(`  ✖ ${f.path}:${f.line}  ${f.what}: ${f.src}`)
  if (found.length) {
    console.log(`\n✖ ${found.length} lint suppression(s). Delete the comment and fix the code it was hiding.`)
    console.log('  If the rule is wrong for this code, stop and ask the owner. Do not add an exemption.')
    process.exitCode = 1
    return
  }
  console.log('✓ no lint suppressions')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
