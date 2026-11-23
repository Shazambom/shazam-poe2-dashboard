// The one fetch the desktop runtime uses to reach its own backend. CLAUDE.md's desktop contract: every
// /api request is served by the bundled local backend on 127.0.0.1, never a remote server. Callers pass
// the full URL (main.js resolves it) and keep their own timeouts and error handling; a URL that is not
// the local backend is refused before any request, as a rejected promise, the same shape a network
// failure has. The only other origin is the dev backend main.js registers in an unpackaged run that has
// no bundled binary (allowDevBackend); a packaged build never registers one.
'use strict'

let devOrigin = null

function isLocalBackend(url) {
  try {
    const u = new URL(String(url))
    return (u.protocol === 'http:' && u.hostname === '127.0.0.1') || (devOrigin !== null && u.origin === devOrigin)
  } catch {
    return false
  }
}

/**
 * @param {string} url the backend URL, e.g. http://127.0.0.1:8210/api/status
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
function backendFetch(url, init) {
  if (!isLocalBackend(url)) return Promise.reject(new Error(`not the local backend: ${String(url).slice(0, 80)}`))
  return fetch(url, init)
}

/** DEV ONLY: main.js's unpackaged branch, when it points the app at a dev backend instead. */
function allowDevBackend(url) { devOrigin = new URL(url).origin }

module.exports = { backendFetch, allowDevBackend }
