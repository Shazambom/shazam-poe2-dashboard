// desktop/src/settings-store.js: desktop-settings.json is read at startup and written synchronously on every
// change, so a change made just before quit is on disk when the process exits (no pending async write).
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { loadSettings, writeSettings, readSettingsFile } = require('../src/settings-store.js')
const STORE = new URL('../src/settings-store.js', import.meta.url).pathname

const DEFAULTS = { betaChannel: false, theme: 'vault' }

test('missing or unreadable file: the defaults, as a fresh object', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    const a = loadSettings(() => join(dir, 'nope.json'), DEFAULTS)
    assert.deepEqual(a, DEFAULTS); assert.notEqual(a, DEFAULTS)
    writeFileSync(join(dir, 'bad.json'), '{not json')
    assert.deepEqual(loadSettings(() => join(dir, 'bad.json'), DEFAULTS), DEFAULTS)
    assert.deepEqual(loadSettings(() => { throw new Error('no userData yet') }, DEFAULTS), DEFAULTS)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('saved values override the defaults; unknown keys are kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    const f = join(dir, 'desktop-settings.json')
    writeFileSync(f, JSON.stringify({ theme: 'ash', focusHotkey: 'Alt+G' }))
    assert.deepEqual(loadSettings(() => f, DEFAULTS), { betaChannel: false, theme: 'ash', focusHotkey: 'Alt+G' })
    assert.deepEqual(readSettingsFile(f), { theme: 'ash', focusHotkey: 'Alt+G' })
    assert.throws(() => readSettingsFile(join(dir, 'missing.json')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a write is on disk before writeSettings returns, pretty-printed; a failed write never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    const f = join(dir, 'desktop-settings.json')
    writeSettings(() => f, { betaChannel: true, theme: 'vaal' })
    assert.equal(readFileSync(f, 'utf8'), JSON.stringify({ betaChannel: true, theme: 'vaal' }, null, 2))
    mkdirSync(join(dir, 'is-a-dir'))
    assert.doesNotThrow(() => writeSettings(() => join(dir, 'is-a-dir'), DEFAULTS))
    assert.doesNotThrow(() => writeSettings(() => { throw new Error('no userData') }, DEFAULTS))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a write made right before the process exits survives it (the quit path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    const f = join(dir, 'desktop-settings.json')
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify(STORE)}).writeSettings(() => ${JSON.stringify(f)}, { theme: 'divinity' }); process.exit(0)`])
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { theme: 'divinity' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
