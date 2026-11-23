// The port's fetch(): serves `ee2data://…` from the data dir and refuses everything else. Installed
// on globalThis by index.js for the lifetime of the worker/CLI process (never inside main).
'use strict'
const fs = require('node:fs'), path = require('node:path')
/**
 * A fetch for EE2's data loader: serves ee2data:// from dataDir with the few Response members it reads.
 * @param {string} dataDir
 * @returns {(url: string | URL | Request) => Promise<any>}
 */
function makeFetch(dataDir) {
  return async function ee2Fetch(url) {
    const u = String(url)
    if (!u.startsWith('ee2data://')) throw new Error(`ee2-query: network disabled (${u.slice(0, 60)})`)
    const rel = u.slice('ee2data://'.length).replace(/^data\//, '')
    const file = path.join(dataDir, rel)
    let buf = fs.readFileSync(file)
    // The .index.bin offsets are byte positions in the LF ndjson. A checkout that rewrote line endings
    // (Windows autocrlf did this once) would shift every offset — normalise defensively.
    if (rel.endsWith('.ndjson') && buf.includes(13)) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
    return { ok: true, status: 200, text: async () => buf.toString('utf8'), json: async () => JSON.parse(buf.toString('utf8')), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
  }
}
module.exports = { makeFetch }
