// A random 128-bit id per install, kept at <dataDir>/install-id (0600). It travels only INSIDE the
// sealed report, so the owner can tell two reports from one machine apart without it ever being
// readable by anyone else. Not an identity — a new id is just "unknown reporter".
'use strict'
const { ignored } = require('../ignored.js')
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')

function installId(dataDir) {
  const file = path.join(dataDir, 'install-id')
  try {
    const cur = fs.readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{32}$/.test(cur)) return cur
  } catch (e) { ignored('feedback:read-install-id', e) }
  const id = randomBytes(16).toString('hex')
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, id + '\n', { mode: 0o600 }) } catch (e) { ignored('feedback:write-install-id', e) }
  return id
}

module.exports = { installId }
