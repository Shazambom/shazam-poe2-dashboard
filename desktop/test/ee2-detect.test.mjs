// detectEE2 (desktop/src/integrations/exiled-exchange/detect.js) finds EE2 by its config dir: the config
// file, else the dir alone, else nothing. The home dir is pointed at a temp dir for the test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { detectEE2 } = require('../src/integrations/exiled-exchange/detect.js')

// Where detect.js looks on this platform, under a fake home.
const ee2Dir = (home) => (process.platform === 'win32' ? join(home, 'AppData', 'Roaming', 'exiled-exchange-2')
  : process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'exiled-exchange-2')
    : join(home, '.config', 'exiled-exchange-2'))

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'arb-ee2-'))
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.APPDATA; delete process.env.XDG_CONFIG_HOME
  try { await fn(home) } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    rmSync(home, { recursive: true, force: true })
  }
}

test('no EE2 dir: not present', () => withHome(async () => {
  assert.deepEqual(await detectEE2(), { present: false, method: 'none', dir: null, config: null, running: false })
}))

test('the EE2 dir without a config: present by config-dir, config null', () => withHome(async (home) => {
  mkdirSync(ee2Dir(home), { recursive: true })
  assert.deepEqual(await detectEE2(), { present: true, method: 'config-dir', dir: ee2Dir(home), config: null, running: false })
}))

test('the EE2 config file: present, with its path', () => withHome(async (home) => {
  mkdirSync(join(ee2Dir(home), 'apt-data'), { recursive: true })
  writeFileSync(join(ee2Dir(home), 'apt-data', 'config.json'), '{}')
  assert.deepEqual(await detectEE2(), { present: true, method: 'config-dir', dir: ee2Dir(home), config: join(ee2Dir(home), 'apt-data', 'config.json'), running: false })
}))
