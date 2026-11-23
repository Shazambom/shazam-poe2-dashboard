// Stubbed tests for ops/upload-seed-github.sh covering release lookup (200 vs 404 vs error),
// existing-asset deletion, and loud failure on API errors instead of swallowing them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname
const SCRIPT = join(ROOT, 'ops/upload-seed-github.sh')

function setup(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'upload-seed-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const payload = join(dir, 'market-seed.sqlite.gz')
  writeFileSync(payload, 'fake-seed-bytes')
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario))

  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'scenario.json'))}, "utf8"));
let method = "GET";
let outFile = null;
let writeOut = null;
let url = "";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-X") { method = args[++i]; }
  else if (args[i] === "-o") { outFile = args[++i]; }
  else if (args[i] === "-w") { writeOut = args[++i]; }
  else if (args[i] === "-H" || args[i] === "-d" || args[i] === "--data-binary") { i++; }
  else if (args[i].startsWith("http")) { url = args[i]; }
}
fs.appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, method + " " + url + "\\n");

function respond(resp) {
  if (resp.exitCode) process.exit(resp.exitCode);
  const body = typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body ?? {});
  const code = String(resp.status ?? 200);
  if (outFile) fs.writeFileSync(outFile, body);
  else process.stdout.write(body);
  if (writeOut === "%{http_code}") process.stdout.write(code);
  if (!outFile && Number(code) >= 400) process.exit(22);
  process.exit(0);
}

if (method === "GET" && url.includes("/releases/tags/")) respond(scenario.tagLookup);
if (method === "POST" && url.endsWith("/releases")) respond(scenario.createRelease ?? { status: 201, body: { id: 99 } });
if (method === "GET" && url.endsWith("/assets")) respond(scenario.listAssets ?? { status: 200, body: [] });
if (method === "DELETE" && url.includes("/releases/assets/")) respond(scenario.deleteAsset ?? { status: 204, body: "" });
if (url.includes("uploads.github.com")) respond(scenario.upload ?? { status: 201, body: { id: 777 } });
process.stderr.write("unexpected curl call: " + method + " " + url + "\\n");
process.exit(99);
`,
  )
  chmodSync(join(bin, 'curl'), 0o755)

  const run = () =>
    spawnSync('bash', [SCRIPT, payload], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_TOKEN: 'test-token',
        GH_REPO: 'owner/repo',
      },
      encoding: 'utf8',
    })
  const calls = () => {
    try {
      return readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
  return { run, calls }
}

test('existing release replaces matching asset and uploads', () => {
  const s = setup({
    tagLookup: { status: 200, body: { id: 42 } },
    listAssets: { status: 200, body: [{ id: 501, name: 'market-seed.sqlite.gz' }] },
  })
  const r = s.run()
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.deepEqual(s.calls(), [
    'GET https://api.github.com/repos/owner/repo/releases/tags/market-seed-latest',
    'GET https://api.github.com/repos/owner/repo/releases/42/assets',
    'DELETE https://api.github.com/repos/owner/repo/releases/assets/501',
    'GET https://uploads.github.com/repos/owner/repo/releases/42/assets?name=market-seed.sqlite.gz',
  ])
})

test('missing release (404) creates the rolling release and skips delete when asset is absent', () => {
  const s = setup({
    tagLookup: { status: 404, body: { message: 'Not Found' } },
    createRelease: { status: 201, body: { id: 88 } },
    listAssets: { status: 200, body: [] },
  })
  const r = s.run()
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.deepEqual(s.calls(), [
    'GET https://api.github.com/repos/owner/repo/releases/tags/market-seed-latest',
    'POST https://api.github.com/repos/owner/repo/releases',
    'GET https://api.github.com/repos/owner/repo/releases/88/assets',
    'GET https://uploads.github.com/repos/owner/repo/releases/88/assets?name=market-seed.sqlite.gz',
  ])
})

test('release lookup HTTP 500 fails loudly without trying to create a release', () => {
  const s = setup({
    tagLookup: { status: 500, body: { message: 'Internal Server Error' } },
  })
  const r = s.run()
  assert.notEqual(r.status, 0)
  assert.deepEqual(s.calls(), [
    'GET https://api.github.com/repos/owner/repo/releases/tags/market-seed-latest',
  ])
})

test('asset list API failure stops the upload instead of being swallowed', () => {
  const s = setup({
    tagLookup: { status: 200, body: { id: 42 } },
    listAssets: { exitCode: 22 },
  })
  const r = s.run()
  assert.notEqual(r.status, 0)
  assert.equal(s.calls().some((c) => c.includes('uploads.github.com')), false)
})

test('asset DELETE failure stops the upload instead of being swallowed', () => {
  const s = setup({
    tagLookup: { status: 200, body: { id: 42 } },
    listAssets: { status: 200, body: [{ id: 501, name: 'market-seed.sqlite.gz' }] },
    deleteAsset: { exitCode: 22 },
  })
  const r = s.run()
  assert.notEqual(r.status, 0)
  assert.equal(s.calls().some((c) => c.includes('uploads.github.com')), false)
})
