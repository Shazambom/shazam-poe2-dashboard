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

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
  '.m4a': 'audio/mp4' }

// Ends a request that failed: 404 for a file that is gone, 500 for anything else, or, when the headers
// already went out, a cut response.
function answerFailure(res, e) {
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(e?.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' })
  res.end()
}

// Sends `file` on `res`. The 200 goes out only once the file is open: a file that cannot be opened is a
// 404 (gone) or 500 (anything else), and a read that fails after the headers went out cuts the response.
// Either way `onError` hears it once and nothing is thrown (an unhandled stream error would be an
// uncaught exception in main).
function sendFile(fsm, res, file, headers, onError) {
  const stream = fsm.createReadStream(file)
  let failed = false
  stream.on('error', (e) => {
    if (failed) return
    failed = true
    onError(e)
    answerFailure(res, e)
  })
  stream.on('open', () => {
    res.writeHead(200, headers)
    stream.pipe(res)
  })
  res.on('close', () => { stream.destroy() })   // a client that leaves stops the read
}

// Answers one request for a file of the bundle on `res`; never throws. `fsm` is node:fs (its promises
// and createReadStream). `onError` hears a failure once.
function serveStatic(fsm, dist, pathname, res, onError) {
  return staticFile(fsm.promises, dist, pathname).then((f) => {
    const headers = { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }
    if (pathname.startsWith('/assets/')) headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    sendFile(fsm, res, f, headers, onError)
  }).catch((e) => { onError(e); answerFailure(res, e) })
}

module.exports = { staticFile, serveStatic }
