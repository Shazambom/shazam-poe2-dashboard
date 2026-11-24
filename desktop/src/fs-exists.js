// "Does this path exist?" for the desktop main process, the one helper for it.
'use strict'

// fs.existsSync's answer, without blocking: false for any error (missing, unreadable parent). Asked through
// stat, never access: Electron's fs.promises.access answers ENOENT for a directory inside app.asar, which is
// where the packaged app-dist lives. `fsp` is fs.promises (or a double of it).
/** @param {{ stat: (p: string) => Promise<any> }} fsp @param {string} p @returns {Promise<boolean>} */
async function exists(fsp, p) {
  try {
    await fsp.stat(p)
    return true
  } catch {
    return false
  }
}

module.exports = { exists }
