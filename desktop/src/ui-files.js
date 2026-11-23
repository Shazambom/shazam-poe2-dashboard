// The local UI server's file lookup: which file of the built frontend answers a request path.
'use strict'
const path = require('node:path')

// The file under `dist` for `pathname`; index.html for '/', for anything outside dist, for a missing
// file and for a directory (the single-page app routes those itself). `fsp` is fs.promises.
async function staticFile(fsp, dist, pathname) {
  const index = path.join(dist, 'index.html')
  const f = path.join(dist, pathname === '/' ? 'index.html' : pathname)
  if (!f.startsWith(dist)) return index
  try {
    return (await fsp.stat(f)).isDirectory() ? index : f
  } catch {
    return index   // missing (what existsSync answered false for)
  }
}

module.exports = { staticFile }
