// desktop-settings.json in the user-data dir (theme, beta channel, focus hotkey, …): read once at startup
// and written SYNCHRONOUSLY on every change, so a change made just before quit is on disk when the
// process exits (an async write could still be pending then). This is the one desktop module allowed
// synchronous file I/O for that reason (the n/no-sync exception in ops/lint/eslint.config.mjs).
// file() is called inside the guard, so a user-data path that is not available yet reads as defaults.
//
// The file is the user's: only a missing file starts from the defaults. A write goes to a temp file beside
// it and is renamed over it, so a crash or a full disk mid-write leaves the old file whole. A file that is
// there but cannot be read or parsed is moved aside (<file>.corrupt-<time>, the newest KEEP_CORRUPT kept)
// before the defaults are used, so no later write replaces it.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { ignored } = require('./ignored.js')

const KEEP_CORRUPT = 2
// Paths whose unreadable file could not be moved aside: never written over this run.
const held = new Set()

/** The parsed file; throws when it is missing or not JSON (callers fall back to their defaults). */
const readSettingsFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

// The kept-aside copies of `f`, oldest first: [name, stamp] pairs.
function corruptCopies(f) {
  const prefix = `${path.basename(f)}.corrupt-`
  return fs.readdirSync(path.dirname(f))
    .filter(n => n.startsWith(prefix))
    .map(n => /** @type {[string, number]} */ ([n, Number(n.slice(prefix.length))]))
    .filter(([, t]) => Number.isFinite(t))
    .sort((a, b) => a[1] - b[1])
}

// Moves an unreadable settings file aside and drops all but the newest KEEP_CORRUPT copies. Returns
// whether the path is free for a new file. The stamp is the time, or one past the newest copy, so a new
// copy always sorts newest.
function keepAside(f) {
  let stamp = Date.now()
  try {
    const newest = corruptCopies(f).at(-1)
    if (newest && newest[1] >= stamp) stamp = newest[1] + 1
    fs.renameSync(f, `${f}.corrupt-${stamp}`)
  } catch (e) {
    ignored('settings:keep-aside', e)
    return false
  }
  console.log(`[settings] ${f} could not be read; kept as ${path.basename(f)}.corrupt-${stamp}, starting from the defaults`)
  try {
    for (const [n] of corruptCopies(f).slice(0, -KEEP_CORRUPT)) fs.rmSync(path.join(path.dirname(f), n), { recursive: true, force: true })
  } catch (e) { ignored('settings:prune-corrupt', e) }
  return true
}

/** The saved settings over the defaults, or a copy of the defaults when there is no file. */
function loadSettings(file, defaults) {
  let f
  try { f = file() } catch (e) { ignored('settings:read', e); return { ...defaults } }
  try { return { ...defaults, ...readSettingsFile(f) } } catch (e) {
    if (e?.code !== 'ENOENT') {
      ignored('settings:read', e)
      if (!keepAside(f)) held.add(f)
    }
    return { ...defaults }
  }
}

/** Writes settings now, before returning; true when they are on disk. A failure is logged, never thrown. */
function writeSettings(file, settings) {
  let tmp = null
  let fd = null
  try {
    const f = file()
    if (held.has(f)) throw new Error(`${f} could not be read or moved aside; not writing over it`)
    tmp = `${f}.${process.pid}.tmp`
    fd = fs.openSync(tmp, 'w')
    fs.writeSync(fd, JSON.stringify(settings, null, 2))
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, f)
    return true
  } catch (e) {
    ignored('settings:write', e)
    try {
      if (fd !== null) fs.closeSync(fd)
      if (tmp) fs.rmSync(tmp, { force: true })
    } catch (e2) { ignored('settings:write-cleanup', e2) }
    return false
  }
}

/**
 * Applies `patch` to `settings` and writes them. When the write fails the settings get their old values
 * back (a key the patch added is removed), so memory never holds what the disk does not. True when it landed.
 */
function updateSettings(file, settings, patch) {
  const before = Object.fromEntries(Object.keys(patch).filter(k => k in settings).map(k => [k, settings[k]]))
  Object.assign(settings, patch)
  if (writeSettings(file, settings)) return true
  for (const k of Object.keys(patch)) {
    if (k in before) settings[k] = before[k]
    else delete settings[k]
  }
  return false
}

module.exports = { readSettingsFile, loadSettings, writeSettings, updateSettings }
