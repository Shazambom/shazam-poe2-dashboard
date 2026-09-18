// A random 128-bit id per install, kept at <dataDir>/install-id (0600). It travels only INSIDE the
// sealed report, so the owner can tell two reports from one machine apart without it ever being
// readable by anyone else. Not an identity — a new id is just "unknown reporter".
'use strict'
const fs = require('fs')
const path = require('path')
const { randomBytes } = require('crypto')

function installId(dataDir) {
  const file = path.join(dataDir, 'install-id')
  try {
    const cur = fs.readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{32}$/.test(cur)) return cur
  } catch {}
  const id = randomBytes(16).toString('hex')
  try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, id + '\n', { mode: 0o600 }) } catch {}
  return id
}

module.exports = { installId }
