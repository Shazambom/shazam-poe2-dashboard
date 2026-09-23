#!/usr/bin/env node
// Refresh the vendored EE2 query port (desktop/src/vendor/ee2-query) from a pinned EE2 release:
//   node scripts/sync-ee2.mjs                 # latest GitHub release tag of Kvan7/Exiled-Exchange-2
//   node scripts/sync-ee2.mjs --tag v0.16.3   # pin a tag
//   node scripts/sync-ee2.mjs --src ~/Exiled-Exchange-2   # dev: a local checkout (copied, never modified)
//   --offline   reuse data/trade/*.json instead of fetching GGG's /api/trade2/data
//   --no-goldens   skip regenerating goldens with EE2's own vitest run
// Run by publish-github.sh before the test gate on every release; any failing step aborts.
// Steps: fetch/copy → npm install (once per tag) → make-index-files → esbuild with shim aliases →
// copy data + index bins → GGG trade-data snapshot → goldens via EE2's vitest → MANIFEST.json.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DESKTOP = path.resolve(HERE, '..')
const VENDOR = path.join(DESKTOP, 'src', 'vendor', 'ee2-query')
const FIXTURES = path.join(DESKTOP, 'test', 'fixtures', 'ee2')
const GOLDENS = path.join(DESKTOP, 'test', 'goldens', 'ee2-query')
const CACHE = path.join(os.homedir(), '.cache', 'arbiter', 'ee2')
const REPO = 'Kvan7/Exiled-Exchange-2'
const GGG = 'https://www.pathofexile.com/api/trade2/data'

const args = process.argv.slice(2)
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
const has = (k) => args.includes(k)
const log = (m) => console.log(`[sync-ee2] ${m}`)
const sh = (cmd, cwd) => { log(`$ ${cmd}`); execSync(cmd, { cwd, stdio: 'inherit' }) }
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

// 1. Source: a local checkout (dev) or a release tag fetched into the cache.
async function resolveSource() {
  const src = opt('--src')
  if (src) {
    const root = path.resolve(src.replace(/^~/, os.homedir()))
    const commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim()
    const dir = path.join(CACHE, `local-${commit}`)
    if (!fs.existsSync(path.join(dir, 'renderer', 'package.json'))) {
      fs.mkdirSync(dir, { recursive: true })
      sh(`rsync -a --exclude node_modules --exclude .git ${JSON.stringify(root + '/renderer')} ${JSON.stringify(root + '/ipc')} ${JSON.stringify(root + '/LICENSE')} ${JSON.stringify(dir + '/')}`)
    }
    return { dir, tag: `local-${commit}`, commit }
  }
  let tag = opt('--tag')
  if (!tag) {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'arbiter-sync-ee2' } })
    if (!r.ok) throw new Error(`GitHub releases/latest → ${r.status}`)
    tag = (await r.json()).tag_name
  }
  const dir = path.join(CACHE, tag)
  if (!fs.existsSync(path.join(dir, 'renderer', 'package.json'))) {
    fs.mkdirSync(dir, { recursive: true })
    const tgz = path.join(dir, 'src.tgz')
    const r = await fetch(`https://github.com/${REPO}/archive/refs/tags/${tag}.tar.gz`, { headers: { 'User-Agent': 'arbiter-sync-ee2' } })
    if (!r.ok) throw new Error(`tarball ${tag} → ${r.status}`)
    fs.writeFileSync(tgz, Buffer.from(await r.arrayBuffer()))
    sh(`tar -xzf src.tgz --strip-components=1 --include='*/renderer/*' --include='*/ipc/*' --include='*/LICENSE'`, dir)
    fs.unlinkSync(tgz)
  }
  const r = await fetch(`https://api.github.com/repos/${REPO}/git/ref/tags/${tag}`, { headers: { 'User-Agent': 'arbiter-sync-ee2' } })
  const commit = r.ok ? String((await r.json()).object?.sha || '').slice(0, 12) : ''
  return { dir, tag, commit }
}

// 2. Dependencies, once per tag (EE2's lock is out of sync with npm ci; npm install honours it).
// Installed with the SAME modern node's npm that runs vitest, so platform bindings (rolldown) resolve.
function ensureDeps(renderer) {
  if (fs.existsSync(path.join(renderer, 'node_modules', '.bin', 'vitest'))) return
  // npm must run ON the modern node (npm 11 refuses Node 18): put that node first on PATH for the call.
  const node = modernNode()
  log(`$ npm install (node ${path.dirname(node)})`)
  execSync('npm install --no-audit --no-fund --ignore-scripts', { cwd: renderer, stdio: 'inherit', env: { ...process.env, PATH: `${path.dirname(node)}:${process.env.PATH || ''}` } })
}

// 3. Index files the data loader requires (build artifacts, not in the repo).
function makeIndexFiles(renderer) { sh('node src/assets/make-index-files.mjs', renderer) }

// 4. esbuild: EE2's TS from the cache + our shims, one CommonJS bundle, no externals.
async function bundle(renderer) {
  const src = path.join(renderer, 'src')
  // Shims stay EXTERNAL (required at runtime from ../shims) so index.js and the bundle share one instance.
  const shim = (f) => '../shims/' + f
  // Aliases keyed by the RESOLVED source file, so `@/web/Config`, `./Config` and `../client-string-loader`
  // all hit the shim regardless of how EE2 spelled the import.
  const ALIAS_ABS = {
    [path.join(src, 'web/Config.ts')]: shim('config.js'), [path.join(src, 'web/background/IPC.ts')]: shim('ipc.js'),
    [path.join(src, 'web/background/Prices.ts')]: shim('prices.js'), [path.join(src, 'web/background/TradeData.ts')]: shim('tradedata.js'),
    [path.join(src, 'assets/client-string-loader.ts')]: shim('clientstrings.js'),
  }
  const ALIAS_PKG = { vue: shim('vue.js'), '@vueuse/core': shim('vueuse.js') }
  const resolveTs = (p) => { for (const c of [p, p + '.ts', p + '.js', path.join(p, 'index.ts')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; return null }
  const plugin = {
    name: 'ee2-aliases',
    setup(b) {
      b.onResolve({ filter: /.*/ }, (a) => {
        if (ALIAS_PKG[a.path]) return { path: ALIAS_PKG[a.path], external: true }
        let abs = null
        if (a.path.startsWith('@ipc/')) abs = path.join(renderer, '..', 'ipc', a.path.slice(5))
        else if (a.path.startsWith('@/')) abs = path.join(src, a.path.slice(2))
        else if (a.path.startsWith('.') && a.resolveDir) abs = path.join(a.resolveDir, a.path)
        if (!abs) return undefined
        const file = resolveTs(abs)
        if (!file) { if (a.path.startsWith('@')) throw new Error(`cannot resolve ${a.path} from ${a.importer}`); return undefined }
        return ALIAS_ABS[file] ? { path: ALIAS_ABS[file], external: true } : { path: file }
      })
    },
  }
  fs.mkdirSync(path.join(VENDOR, 'vendor'), { recursive: true })
  const out = path.join(VENDOR, 'vendor', 'bundle.cjs')
  const result = await esbuild.build({
    entryPoints: [path.join(VENDOR, 'entry.js')], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: out,
    absWorkingDir: renderer, nodePaths: [path.join(renderer, 'node_modules')], plugins: [plugin], logLevel: 'warning', legalComments: 'none',
    define: { 'import.meta.env.BASE_URL': '"ee2data://"', 'import.meta.env.DEV': 'false', 'import.meta.env.MODE': '"production"' },
    banner: { js: '// GENERATED by desktop/scripts/sync-ee2.mjs from Exiled-Exchange-2 (MIT) — do not edit; see PROVENANCE.md' },
    metafile: true,
  })
  const inputs = Object.keys(result.metafile.inputs).filter(p => !p.includes('node_modules') && !p.includes('/shims/'))
  log(`bundled ${inputs.length} EE2 modules → ${path.relative(DESKTOP, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`)
  return inputs
}

// 5. Data files + index bins (en only) and the two root JSONs init() loads.
function copyData(renderer) {
  const pub = path.join(renderer, 'public', 'data')
  const en = path.join(VENDOR, 'data', 'en'); fs.mkdirSync(en, { recursive: true })
  for (const f of ['items.ndjson', 'stats.ndjson', 'app_i18n.json', 'items-name.index.bin', 'items-ref.index.bin', 'stats-ref.index.bin', 'stats-matcher.index.bin']) fs.copyFileSync(path.join(pub, 'en', f), path.join(en, f))
  // an ES module; .mjs so Node imports it without a package "type" (the shim imports it by URL)
  fs.copyFileSync(path.join(pub, 'en', 'client_strings.js'), path.join(en, 'client_strings.mjs'))
  for (const f of ['item-drop.json', 'patrons.json']) fs.copyFileSync(path.join(pub, f), path.join(VENDOR, 'data', f))
}

// 6. GGG trade-data snapshot (the parser's network fallbacks read this at runtime instead of fetching).
async function snapshotTradeData() {
  const dir = path.join(VENDOR, 'data', 'trade'); fs.mkdirSync(dir, { recursive: true })
  for (const kind of ['items', 'stats']) {
    const f = path.join(dir, `${kind}.json`)
    if (has('--offline') && fs.existsSync(f)) { log(`offline: keeping ${kind}.json`); continue }
    const r = await fetch(`${GGG}/${kind}`, { headers: { 'User-Agent': 'arbiter-sync-ee2 (release-time snapshot, one request)' } })
    if (!r.ok) throw new Error(`${GGG}/${kind} → ${r.status}`)
    const j = await r.json()
    if (!Array.isArray(j.result)) throw new Error(`${kind}: unexpected shape`)
    // GGG returns each group's entries in a different order per fetch; written as fetched, every
    // release committed unchanged files (850 KB of stats, 186 KB of items). Sorted by each entry's
    // canonical JSON (stats carry an id, items do not), an unchanged upstream is an unchanged file.
    const canon = (e) => JSON.stringify(e, Object.keys(e).sort())
    for (const g of j.result) if (Array.isArray(g.entries)) g.entries.sort((a, b) => { const x = canon(a), y = canon(b); return x < y ? -1 : x > y ? 1 : 0 })
    fs.writeFileSync(f, JSON.stringify(j))
    await new Promise(r => setTimeout(r, 1500))
  }
}

// EE2's vitest needs Node ≥ 20; use this process's node when it qualifies, else a newer one on PATH/Homebrew.
function modernNode() {
  const major = (bin) => { try { return Number(execSync(`${JSON.stringify(bin)} -p "process.versions.node.split('.')[0]"`).toString().trim()) } catch { return 0 } }
  for (const bin of [process.execPath, '/opt/homebrew/bin/node', '/usr/local/bin/node', 'node']) if (major(bin) >= 20) return bin
  throw new Error('golden generation needs Node ≥ 20 (EE2 vitest); none found')
}

// 7. Goldens: run EE2's OWN code at this tag under its vitest setup over our fixtures.
function regenerateGoldens(renderer) {
  const specDir = path.join(renderer, 'specs', 'arbiter'); fs.mkdirSync(specDir, { recursive: true })
  fs.copyFileSync(path.join(HERE, 'ee2-goldens.spec.ts'), path.join(specDir, 'goldens.test.ts'))
  fs.rmSync(GOLDENS, { recursive: true, force: true }); fs.mkdirSync(GOLDENS, { recursive: true })
  const r = spawnSync(modernNode(), [path.join(renderer, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'specs/arbiter'], { cwd: renderer, stdio: 'inherit', env: { ...process.env, ARBITER_FIXTURES: FIXTURES, ARBITER_GOLDENS: GOLDENS, ARBITER_TRADE_DATA: path.join(VENDOR, 'data', 'trade') } })
  if (r.status !== 0) throw new Error('golden generation (EE2 vitest) failed')
}

// 8. Manifest: every vendored file's hash so a hand edit is caught by the drift test.
function writeManifest(meta) {
  const files = {}
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name !== 'MANIFEST.json') files[path.relative(VENDOR, p).split(path.sep).join('/')] = { sha256: sha256(p), bytes: fs.statSync(p).size } } }
  walk(path.join(VENDOR, 'vendor')); walk(path.join(VENDOR, 'data'))
  fs.writeFileSync(path.join(VENDOR, 'data', 'MANIFEST.json'), JSON.stringify({ ...meta, syncedAt: new Date().toISOString(), files }, null, 1))
}

const { dir, tag, commit } = await resolveSource()
const renderer = path.join(dir, 'renderer')
log(`source ${tag} (${commit || '?'}) at ${dir}`)
ensureDeps(renderer)
makeIndexFiles(renderer)
const modules = await bundle(renderer)
copyData(renderer)
await snapshotTradeData()
if (!has('--no-goldens')) regenerateGoldens(renderer)
writeManifest({ ee2Tag: tag, ee2Commit: commit, modules: modules.map(m => path.relative(renderer, path.resolve(renderer, m))).sort() })
log('done')
