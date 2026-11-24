// desktop/src/settings-store.js: desktop-settings.json is read at startup and written synchronously on every
// change, so a change made just before quit is on disk when the process exits (no pending async write).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { loadSettings, writeSettings, updateSettings, readSettingsFile } = require('../src/settings-store.js')
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

const tmpLeft = (dir) => readdirSync(dir).filter(n => n.includes('.tmp'))

test('writeSettings answers whether the write landed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    assert.equal(writeSettings(() => join(dir, 'desktop-settings.json'), DEFAULTS), true)
    mkdirSync(join(dir, 'is-a-dir'))
    assert.equal(writeSettings(() => join(dir, 'is-a-dir'), DEFAULTS), false)
    assert.equal(writeSettings(() => { throw new Error('no userData') }, DEFAULTS), false)
    assert.deepEqual(tmpLeft(dir), [], 'no temp file left behind')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// The write goes to a temp file beside the target and is renamed over it: a crash or a full disk mid-write
// leaves the old file whole, never a half-written one that the next start cannot parse.
test('a write that fails leaves the previous file intact and readable', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    const f = join(dir, 'desktop-settings.json')
    assert.equal(writeSettings(() => f, { theme: 'ash' }), true)
    const before = readFileSync(f, 'utf8')
    const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    const realWrite = fs.writeSync
    const realWriteFile = fs.writeFileSync
    t.mock.method(fs, 'writeSync', (fd, data, ...rest) => {   // half the bytes reach the disk, then it is full
      realWrite(fd, String(data).slice(0, 5), ...rest)
      throw enospc
    })
    t.mock.method(fs, 'writeFileSync', (file, data, ...rest) => {
      realWriteFile(file, String(data).slice(0, 5), ...rest)
      throw enospc
    })
    assert.equal(writeSettings(() => f, { theme: 'divinity', betaChannel: true }), false)
    t.mock.restoreAll()
    assert.equal(readFileSync(f, 'utf8'), before)
    assert.deepEqual(loadSettings(() => f, DEFAULTS), { ...DEFAULTS, theme: 'ash' })
    assert.deepEqual(tmpLeft(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('updateSettings: a change that lands is kept; one that fails leaves the settings as they were', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    const f = join(dir, 'desktop-settings.json')
    const s = { betaChannel: false, theme: 'vault' }
    assert.equal(updateSettings(() => f, s, { betaChannel: true }), true)
    assert.deepEqual(s, { betaChannel: true, theme: 'vault' })
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), s)
    mkdirSync(join(dir, 'is-a-dir'))
    assert.equal(updateSettings(() => join(dir, 'is-a-dir'), s, { betaChannel: false, focusHotkey: 'Alt+G' }), false)
    assert.deepEqual(s, { betaChannel: true, theme: 'vault' }, 'old values back, the new key gone')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Only a missing file means "start from the defaults". A file that is there but cannot be read or parsed is
// the user's settings: it is moved aside (desktop-settings.json.corrupt-<time>) before the defaults are used,
// so the next write cannot replace it.
test('an unparseable file is kept aside, never overwritten by the next write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    const f = join(dir, 'desktop-settings.json')
    writeFileSync(f, '{"theme": "ash", "focusHot')
    assert.deepEqual(loadSettings(() => f, DEFAULTS), DEFAULTS)
    const aside = readdirSync(dir).filter(n => n.startsWith('desktop-settings.json.corrupt-'))
    assert.equal(aside.length, 1)
    assert.equal(readFileSync(join(dir, aside[0]), 'utf8'), '{"theme": "ash", "focusHot')
    assert.equal(writeSettings(() => f, { ...DEFAULTS, theme: 'vaal' }), true)
    assert.equal(readFileSync(join(dir, aside[0]), 'utf8'), '{"theme": "ash", "focusHot', 'the kept copy is untouched')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a missing file starts from the defaults and keeps nothing aside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    assert.deepEqual(loadSettings(() => join(dir, 'desktop-settings.json'), DEFAULTS), DEFAULTS)
    assert.deepEqual(readdirSync(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a settings path that cannot be read (a directory) is moved aside too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    const f = join(dir, 'desktop-settings.json')
    mkdirSync(f)
    assert.deepEqual(loadSettings(() => f, DEFAULTS), DEFAULTS)
    assert.equal(readdirSync(dir).filter(n => n.startsWith('desktop-settings.json.corrupt-')).length, 0)
    assert.equal(writeSettings(() => f, DEFAULTS), false, 'held on non-ENOENT read error; never overwritten')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a transient read error (EBUSY) is retried and reads the saved values when it clears', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    const f = join(dir, 'desktop-settings.json')
    const saved = JSON.stringify({ theme: 'ash', focusHotkey: 'Alt+G' })
    writeFileSync(f, saved)
    const realRead = fs.readFileSync
    let calls = 0
    t.mock.method(fs, 'readFileSync', (file, opts) => {
      calls++
      if (calls === 1) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return realRead(file, opts)
    })
    assert.deepEqual(loadSettings(() => f, DEFAULTS), { ...DEFAULTS, theme: 'ash', focusHotkey: 'Alt+G' })
    assert.equal(calls, 2)
    t.mock.restoreAll()
    assert.equal(readdirSync(dir).filter(n => n.startsWith('desktop-settings.json.corrupt-')).length, 0)
    assert.equal(readFileSync(f, 'utf8'), saved)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a persistent read error (EBUSY) leaves the valid file in place, creates no corrupt copy, and refuses writes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    const f = join(dir, 'desktop-settings.json')
    const saved = JSON.stringify({ theme: 'ash' })
    writeFileSync(f, saved)
    let calls = 0
    t.mock.method(fs, 'readFileSync', () => {
      calls++
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    })
    const started = Date.now()
    assert.deepEqual(loadSettings(() => f, DEFAULTS), DEFAULTS)
    assert.ok(calls > 1, 'read is retried before giving up')
    assert.ok(Date.now() - started < 1000, 'retries stay bounded well under a second')
    t.mock.restoreAll()
    assert.equal(readdirSync(dir).filter(n => n.startsWith('desktop-settings.json.corrupt-')).length, 0)
    assert.equal(readFileSync(f, 'utf8'), saved)
    assert.equal(writeSettings(() => f, DEFAULTS), false)
    assert.equal(updateSettings(() => f, { ...DEFAULTS }, { theme: 'vaal' }), false)
    assert.equal(readFileSync(f, 'utf8'), saved)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('at most two kept-aside copies: the newest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    const f = join(dir, 'desktop-settings.json')
    for (const n of [1, 2, 3, 4]) {
      writeFileSync(f, `{bad ${n}`)
      loadSettings(() => f, DEFAULTS)
    }
    const aside = readdirSync(dir).filter(n => n.startsWith('desktop-settings.json.corrupt-')).sort()
    assert.deepEqual(aside.map(n => readFileSync(join(dir, n), 'utf8')), ['{bad 3', '{bad 4'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an unreadable file that cannot be moved aside is never written over', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    const f = join(dir, 'desktop-settings.json')
    writeFileSync(f, '{bad')
    t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }) })
    assert.deepEqual(loadSettings(() => f, DEFAULTS), DEFAULTS)
    t.mock.restoreAll()
    assert.equal(writeSettings(() => f, DEFAULTS), false)
    assert.equal(updateSettings(() => f, { ...DEFAULTS }, { theme: 'ash' }), false)
    assert.equal(readFileSync(f, 'utf8'), '{bad')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('writeSettings retries transient rename EPERM/EBUSY/EACCES and lands the new content', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    const f = join(dir, 'desktop-settings.json')
    assert.equal(writeSettings(() => f, { theme: 'vault' }), true)
    const realRename = fs.renameSync
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      let calls = 0
      t.mock.method(fs, 'renameSync', (from, to) => {
        calls++
        if (calls === 1) throw Object.assign(new Error(`${code}: target busy`), { code })
        return realRename(from, to)
      })
      const next = { betaChannel: false, theme: code.toLowerCase() }
      assert.equal(writeSettings(() => f, next), true, `${code} transient failure should succeed on retry`)
      assert.equal(calls, 2)
      t.mock.restoreAll()
      assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), next)
      assert.deepEqual(tmpLeft(dir), [])
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('writeSettings gives up cleanly when rename always fails with EPERM, keeping the old file and rolling back memory', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arb-set-'))
  try {
    const f = join(dir, 'desktop-settings.json')
    assert.equal(writeSettings(() => f, { betaChannel: false, theme: 'ash' }), true)
    const before = readFileSync(f, 'utf8')
    let calls = 0
    t.mock.method(fs, 'renameSync', () => {
      calls++
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    })
    const s = { betaChannel: false, theme: 'ash' }
    const started = Date.now()
    assert.equal(updateSettings(() => f, s, { theme: 'vaal' }), false)
    assert.ok(calls > 1, 'rename is retried before giving up')
    assert.ok(Date.now() - started < 1000, 'rename retries stay bounded well under a second')
    t.mock.restoreAll()
    assert.deepEqual(s, { betaChannel: false, theme: 'ash' })
    assert.equal(readFileSync(f, 'utf8'), before)
    assert.deepEqual(tmpLeft(dir), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
