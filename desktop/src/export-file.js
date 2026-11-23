// Settings → Trading → Export searches and Strat Calculator's export: the sandboxed renderer cannot
// download a blob, so main writes the file into the user's Downloads folder (no dialog) and returns
// its path for the toast.
'use strict'
const path = require('node:path')

// Exports are written one at a time, in the order they arrive, as the synchronous write did: two
// exports to the same name leave the later one's text, never a mix.
/** @param {{ fsp: { writeFile: (f: string, d: string) => Promise<any> }, downloads: () => string }} deps */
function makeExporter({ fsp, downloads }) {
  /** @type {Promise<any>} */
  let queue = Promise.resolve()
  /** @param {{ name?: string, text?: string } | null | undefined} p @returns {Promise<string>} */
  return async function exportFile(p) {
    const name = String(p?.name || 'arbiter-searches.json').replace(/[^\w.-]+/g, '_')
    const file = path.join(downloads(), name)
    const write = queue.then(() => fsp.writeFile(file, String(p?.text || '')))
    queue = Promise.allSettled([write])   // the next export waits for this one; its error goes to its caller
    await write
    return file
  }
}

module.exports = { makeExporter }
