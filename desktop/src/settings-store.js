// desktop-settings.json in the user-data dir (theme, beta channel, focus hotkey, …): read once at startup
// and written SYNCHRONOUSLY on every change, so a change made just before quit is on disk when the
// process exits (an async write could still be pending then). This is the one desktop module allowed
// synchronous file I/O for that reason (the n/no-sync exception in ops/lint/eslint.config.mjs).
// file() is called inside the guard, so a user-data path that is not available yet reads as defaults.
'use strict'
const fs = require('node:fs')
const { ignored } = require('./ignored.js')

/** The parsed file; throws when it is missing or not JSON (callers fall back to their defaults). */
const readSettingsFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

/** The saved settings over the defaults, or a copy of the defaults when the file cannot be read. */
function loadSettings(file, defaults) {
  try { return { ...defaults, ...readSettingsFile(file()) } } catch (e) { ignored('settings:read', e); return { ...defaults } }
}

/** Writes settings now, before returning; a failure is logged, never thrown. */
function writeSettings(file, settings) {
  try { fs.writeFileSync(file(), JSON.stringify(settings, null, 2)) } catch (e) { ignored('settings:write', e) }
}

module.exports = { readSettingsFile, loadSettings, writeSettings }
