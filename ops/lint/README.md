# Lint configuration

All linter configurations live under `ops/lint/` and are passed to each tool explicitly by `ops/lint/step.sh`.

## JSON configuration exemptions

JSON files cannot hold comments, so each exemption or scope limit in a JSON config under `ops/lint/` is recorded here with its reason.

### `ops/lint/oxlintrc.json`

- `"categories": { "correctness": "off" }`: ESLint (`ops/lint/eslint.config.mjs`) already owns general JavaScript correctness rules across the repo. Oxlint runs on `frontend/src/**/*.jsx` only for the explicit `react` and `jsx-a11y` rules listed under `"rules"`, so default oxlint correctness rules are turned off to avoid duplicate or conflicting checks.
- `overrides` (`frontend/src/components/TradeBuilder.jsx`, `frontend/src/components/WorkspaceView.jsx`) `react/no-unknown-property` `"ignore": ["allowpopups"]`: `allowpopups` is an Electron `<webview>` HTML attribute that React's DOM property list does not recognize. Those two components are the only places `<webview allowpopups="true">` is rendered.

### `ops/lint/knip.json`

- `workspaces["../../desktop"].ignore`: `["src/vendor/ee2-query/entry.js"]`: `entry.js` is the esbuild entrypoint consumed by `desktop/scripts/sync-ee2.mjs` inside a cached Exiled-Exchange-2 checkout. Its `@/...` imports exist only in upstream EE2's source tree during sync, never in this repo.
- `"ignoreUnresolved": ["virtual:theme-presets"]`: `virtual:theme-presets` is a Vite virtual module generated at build and dev time by `frontend/vite.config.js` and imported by `frontend/src/components/ThemeBuilder.jsx`. It has no file on disk for static import analysis to resolve.

### `ops/lint/ecrc.json`

- `"Disable": { "IndentSize": true }`: Language formatters (`ruff format`, `shfmt`) own indentation width. `editorconfig-checker` enforces charset, LF line endings, final newlines, trailing whitespace, and space indentation (`indent_style`), matching the root `.editorconfig`.
- `"Exclude"` (`^desktop/src/vendor/ee2-query/vendor/`, `^desktop/src/vendor/ee2-query/data/`, `(^|/)tests?/fixtures/`, `(^|/)tests?/goldens?/`, `^frontend/src/data/regex/`): Mirrors `NOT_LINTED` in `ops/lint/files.mjs`. Generated upstream EE2 bundle and data files are hashed by `MANIFEST.json`, test fixtures and goldens are byte-exact, and `frontend/src/data/regex/` is SHA-256 manifest-hashed, so none of them may be reformatted.

### `ops/lint/tsconfig.desktop.json`

- `"strict": false`: Desktop runtime, scripts, and tests (`desktop/src/**/*.js`, `desktop/scripts/**/*.mjs`, `desktop/test/**/*.mjs`) are plain JavaScript checked with `checkJs: true` without full TypeScript annotations. Running with `strict: false` catches property, arity, and type bugs across the entire desktop tree without requiring exhaustive nullability and implicit-`any` annotations everywhere; strict checking is piloted separately in `ops/lint/tsconfig.frontend.json`.

### `ops/lint/pyrightconfig.json`

- `"exclude": ["**/node_modules", "**/__pycache__", "**/.*"]`: Prevents Pyright from crawling installed Node packages, Python bytecode caches, and dot-directories (`.venv-lint`, `.venv-test`, `.git`, `.claude`) when scanning included trees or resolving imports.
