// A random 128-bit id per install, kept at <dataDir>/install-id (0600). It travels only INSIDE the
// sealed report, so the owner can tell two reports from one machine apart without it ever being
// readable by anyone else. Not an identity — a new id is just "unknown reporter".
'use strict'
const { ignored } = require('../ignored.js')
const fsp = require('node:fs').promises
const path = require('node:path')
const { randomBytes } = require('node:crypto')

/** @param {string} dataDir @param {string} file @returns {Promise<string>} */
async function readOrCreate(dataDir, file) {
  try {
    const cur = (await fsp.readFile(file, 'utf8')).trim()
    if (/^[0-9a-f]{32}$/.test(cur)) return cur
  } catch (e) { ignored('feedback:read-install-id', e) }
  const id = randomBytes(16).toString('hex')
  try {
    await fsp.mkdir(dataDir, { recursive: true })
    await fsp.writeFile(file, id + '\n', { mode: 0o600 })
  } catch (e) { ignored('feedback:write-install-id', e) }
  return id
}

// Calls that overlap share one read (and, on a first run, one write): without this, two first calls
// could each mint an id and the second write would replace the first one's.
/** @type {Map<string, Promise<string>>} */
const pending = new Map()

/** @param {string} dataDir @returns {Promise<string>} */
function installId(dataDir) {
  const file = path.join(dataDir, 'install-id')
  let p = pending.get(file)
  if (!p) {
    p = readOrCreate(dataDir, file).finally(() => { pending.delete(file) })
    pending.set(file, p)
  }
  return p
}

module.exports = { installId }
