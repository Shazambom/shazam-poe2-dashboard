// The one ESLint config for frontend/, desktop/ and ops/**/*.mjs. Run from the repo root:
//   ops/lint/node_modules/.bin/eslint -c ops/lint/eslint.config.mjs --max-warnings 0 <files>
// ops/lint/js-steps.sh eslint builds the file list. Every rule is an error; there is no warning tier.
// Plugins load from ops/lint/node_modules; import resolution runs from each linted file, so every
// tree resolves against its own node_modules. Per-path settings are the lines marked "per-path"
// below, each with its reason (lint plan section 5). Adding one needs the owner.
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
import js from '@eslint/js'
import globals from 'globals'
import tsParser from '@typescript-eslint/parser'
import hooks from 'eslint-plugin-react-hooks'
import refresh from 'eslint-plugin-react-refresh'
import vitest from '@vitest/eslint-plugin'
import { importX, createNodeResolver } from 'eslint-plugin-import-x'
import regexp from 'eslint-plugin-regexp'
import promise from 'eslint-plugin-promise'
import sonarjs from 'eslint-plugin-sonarjs'
import unicorn from 'eslint-plugin-unicorn'
import n from 'eslint-plugin-n'
import security from 'eslint-plugin-security'
import noUnsanitized from 'eslint-plugin-no-unsanitized'
import arbiter from './arbiter-plugin.mjs'

// Patterns below are relative to the repo root, wherever ESLint is started from.
const basePath = fileURLToPath(new URL('../..', import.meta.url))

const RENDERER = ['frontend/src/**/*.{js,jsx}']
const LIFECYCLE = ['frontend/test/lifecycle/**/*.{js,jsx}']
const NODE_TESTS = ['frontend/test/*.mjs', 'desktop/test/*.mjs', 'ops/lint/*.test.mjs']
const DESKTOP = ['desktop/src/**/*.js']
const SCRIPTS = ['desktop/scripts/**/*.mjs', 'frontend/scripts/**/*.mjs', 'ops/**/*.mjs', 'frontend/vite.config.js']
const FIRST_PARTY = [...RENDERER, ...LIFECYCLE, ...NODE_TESTS, ...DESKTOP, ...SCRIPTS]
const GOLDENS_SPEC = ['desktop/scripts/ee2-goldens.spec.ts']
// The esbuild entry of the EE2 port: its `@/…` imports resolve only inside EE2's checkout during
// desktop/scripts/sync-ee2.mjs, so like the goldens spec it gets the core and suppression rules only.
const EE2_ENTRY = ['desktop/src/vendor/ee2-query/entry.js']

/** A preset's rules with every enabled rule at error (a preset's `warn` would otherwise pass). */
const atError = (rules) => Object.fromEntries(Object.entries(rules).map(([id, value]) => {
  const [level, ...options] = Array.isArray(value) ? value : [value]
  return [id, level === 'off' || level === 0 ? 'off' : ['error', ...options]]
}))
const on = (prefix, ids) => Object.fromEntries(ids.split(/\s+/).filter(Boolean).map((id) => [`${prefix}/${id}`, 'error']))

const ASK = ' If the rule is wrong for this code, stop and ask the owner.'

// Test control: a focused, skipped or todo test hides the rest of the suite or itself.
const TEST_CONTROL = [
  {
    selector: 'CallExpression[callee.object.name=/^(test|it|describe|suite)$/][callee.property.name=/^(only|skip|todo|skipIf|runIf)$/]',
    message: 'A focused, skipped or todo test hides tests from the run. Delete the modifier and make the test pass.' + ASK,
  },
  {
    selector: 'CallExpression[callee.name=/^(test|it|describe|suite)$/] > ObjectExpression.arguments > Property[key.name=/^(only|skip|todo)$/]:not([value.value=false])',
    message: 'The only/skip/todo option hides tests from the run. Delete it and make the test pass.' + ASK,
  },
  {
    selector: 'CallExpression[callee.object.name=/^(t|ctx|context)$/][callee.property.name=/^(skip|todo)$/]',
    message: 'Skipping from inside a test hides it from the run. Delete the skip and make the test pass.' + ASK,
  },
]

// OS path variables the desktop runtime may read; everything else in process.env is configuration.
const OS_PATH_VARS = ['APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'HOME', 'USERPROFILE']

// Which module owns each network primitive (lint plan section 3, `network-primitives-allowlist`).
const NETWORK_OWNERS = {
  fetch: ['desktop/src/telemetry.js', 'desktop/src/local-backend.js'],
  net: ['desktop/src/trade/proxy.js'],
  ws: ['desktop/src/trade/engine.js'],
  http: ['desktop/src/main.js'],
}
const TELEMETRY = { owner: 'desktop/src/telemetry.js' }
const RATE_LIMIT_FORWARDERS = { owners: ['desktop/src/trade/tap.js', 'desktop/src/trade/budget.js'] }

const config = [
  {
    ignores: [
      '**/node_modules/**',
      'frontend/dist/**',
      'desktop/app-dist/**',
      'desktop/release/**',
      // Generated upstream code, hashed by the EE2 manifest (desktop/src/vendor/ee2-query/PROVENANCE.md).
      'desktop/src/vendor/ee2-query/vendor/**',
      'desktop/src/vendor/ee2-query/data/**',
      // Byte-exact fixtures and goldens.
      'desktop/test/fixtures/**',
      'desktop/test/goldens/**',
      'frontend/test/goldens/**',
      'frontend/src/data/regex/**',
    ],
  },
  {
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },

  // Core: all first-party JavaScript, plus the EE2 goldens spec through the TypeScript parser.
  {
    files: [...FIRST_PARTY, ...GOLDENS_SPEC],
    plugins: { arbiter },
    rules: {
      ...js.configs.recommended.rules,
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // Empty catch blocks belong to arbiter/catch-must-handle, which also fails a comment-only block.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { caughtErrors: 'all' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'no-promise-executor-return': 'error',
      'arbiter/catch-must-handle': 'error',
    },
  },
  {
    files: GOLDENS_SPEC,
    languageOptions: { parser: tsParser, sourceType: 'module', globals: globals.nodeBuiltin },
    rules: { 'no-restricted-syntax': ['error', ...TEST_CONTROL] },
  },

  // Shared plugins: all first-party JavaScript.
  {
    files: FIRST_PARTY,
    ignores: EE2_ENTRY,
    plugins: { 'import-x': importX, regexp, promise, sonarjs, unicorn },
    settings: {
      'import-x/resolver-next': [createNodeResolver({ extensions: ['.mjs', '.js', '.jsx', '.json', '.css'] })],
      'import-x/extensions': ['.mjs', '.js', '.jsx'],
    },
    rules: {
      ...on('import-x', 'no-unresolved named default namespace export no-duplicates no-self-import no-cycle no-useless-path-segments'),
      ...on('regexp', 'no-dupe-disjunctions no-invalid-regexp no-empty-alternative no-missing-g-flag no-super-linear-backtracking no-useless-dollar-replacements'),
      'promise/catch-or-return': ['error', { allowFinally: true }],
      ...on('promise', 'no-multiple-resolved no-return-in-finally valid-params'),
      ...on('sonarjs', 'no-all-duplicated-branches no-element-overwrite no-extra-arguments no-nested-assignment no-unenclosed-multiline-block'),
      ...on('unicorn', 'no-await-in-promise-methods no-invalid-remove-event-listener no-unnecessary-await'),
    },
  },

  // Renderer: the React app.
  {
    files: RENDERER,
    plugins: { 'react-hooks': hooks, 'no-unsanitized': noUnsanitized },
    languageOptions: { globals: globals.browser, parserOptions: { ecmaFeatures: { jsx: true } } },
    settings: { 'react-hooks': { additionalEffectHooks: '^useApi$' } },
    rules: {
      ...atError(hooks.configs.flat.recommended.rules),
      ...on('no-unsanitized', 'method property'),
      'no-restricted-imports': ['error', {
        paths: [...builtinModules, 'vitest'].map((name) => ({
          name,
          message: 'The renderer runs in the browser: Node built-ins and test libraries do not exist there. '
            + 'Ask the backend or the desktop bridge for the data instead.' + ASK,
        })),
        patterns: [{
          group: ['node:*', '@testing-library/*', 'happy-dom'],
          message: 'The renderer runs in the browser: Node built-ins and test libraries do not exist there.' + ASK,
        }],
      }],
    },
  },
  {
    files: ['frontend/src/**/*.jsx'],
    plugins: { 'react-refresh': refresh },
    rules: atError(refresh.configs.vite.rules),
  },
  {
    // per-path: Vite's virtual module, built by frontend/vite.config.js; ThemeBuilder.jsx is its one importer.
    files: ['frontend/src/components/ThemeBuilder.jsx'],
    rules: { 'import-x/no-unresolved': ['error', { ignore: ['^virtual:theme-presets$'] }] },
  },

  // Lifecycle tests (Vitest + happy-dom).
  {
    files: LIFECYCLE,
    plugins: { vitest },
    languageOptions: {
      globals: { ...globals.nodeBuiltin, ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...atError(vitest.configs.recommended.rules),
      'vitest/no-disabled-tests': 'error',
      'vitest/no-focused-tests': 'error',
      // Matcher-style preference, not a defect.
      'vitest/prefer-called-exactly-once-with': 'off',
    },
  },

  // Node tests (node --test).
  {
    files: NODE_TESTS,
    languageOptions: { globals: globals.nodeBuiltin },
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'vitest', message: 'Node tests run under node --test: import from node:test.' + ASK },
          { name: 'assert', message: 'Use node:assert/strict.' + ASK },
          { name: 'node:assert', message: 'Use node:assert/strict.' + ASK },
          { name: 'assert/strict', message: 'Use node:assert/strict.' + ASK },
        ],
      }],
      'no-restricted-syntax': ['error', ...TEST_CONTROL],
    },
  },

  // Desktop runtime: Electron main, preloads, workers (CommonJS).
  {
    files: DESKTOP,
    ignores: EE2_ENTRY,
    plugins: { n, security },
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: {
      ...atError(n.configs['flat/recommended-script'].rules),
      'n/prefer-node-protocol': 'error',
      'n/hashbang': 'error',
      'n/no-unpublished-require': ['error', { allowModules: ['electron'] }],
      'n/no-sync': ['error', { allowAtRootLevel: true }],
      'no-implicit-coercion': 'error',
      'no-shadow': 'error',
      'no-param-reassign': 'error',
      'consistent-return': 'error',
      strict: ['error', 'safe'],
      complexity: ['error', 15],
      ...on('security', 'detect-non-literal-regexp detect-child-process detect-eval-with-expression detect-new-buffer detect-buffer-noassert detect-pseudoRandomBytes detect-bidi-characters'),
      'arbiter/network-primitives-allowlist': ['error', { owners: NETWORK_OWNERS }],
      'arbiter/telemetry-single-sender': ['error', TELEMETRY],
      'arbiter/no-env-config': ['error', { allow: OS_PATH_VARS }],
      'arbiter/rate-limit-headers-backend-only': ['error', RATE_LIMIT_FORWARDERS],
      'arbiter/secure-web-preferences': 'error',
    },
  },
  {
    files: ['desktop/src/preload*.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      'arbiter/preload-require-electron-only': 'error',
      'arbiter/no-raw-ipcrenderer-expose': 'error',
    },
  },
  {
    // The esbuild entry of the EE2 port is an ES module; everything else in desktop/src is CommonJS.
    files: EE2_ENTRY,
    languageOptions: { sourceType: 'module' },
  },
  {
    // per-path: desktop-settings.json is written synchronously so a change made just before quit is on
    // disk when the process exits; this module is the one place that sync file I/O lives (lint plan section 5).
    files: ['desktop/src/settings-store.js'],
    rules: { 'n/no-sync': 'off' },
  },
  {
    // per-path: the unpackaged dev branch CLAUDE.md sanctions (ARBITER_DEV_BACKEND_URL, falling back to telemetry.SHAZAM).
    files: ['desktop/src/main.js'],
    rules: {
      'arbiter/no-env-config': ['error', { allow: [...OS_PATH_VARS, 'ARBITER_DEV_BACKEND_URL'] }],
      'arbiter/telemetry-single-sender': ['error', { ...TELEMETRY, allowRead: ['SHAZAM'] }],
    },
  },

  // Scripts: developer and build scripts (ES modules on Node).
  {
    files: SCRIPTS,
    plugins: { n },
    languageOptions: { sourceType: 'module', globals: globals.nodeBuiltin },
    rules: {
      ...atError(n.configs['flat/recommended-module'].rules),
      'n/prefer-node-protocol': 'error',
      'n/hashbang': 'error',
    },
  },
  {
    // ops/ scripts run on the Node the lint gate demands (ops/lint/package.json engines); ops/ itself
    // has no package.json, so without this n assumes Node 16 and flags fetch and WebSocket.
    files: ['ops/**/*.mjs'],
    settings: { node: { version: '>=22.22.2' } },
  },
]

export default config.map((block) => ({ basePath, ...block }))
