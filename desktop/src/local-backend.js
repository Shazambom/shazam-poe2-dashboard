// The one fetch the desktop runtime uses to reach its own backend. CLAUDE.md's desktop contract: every
// /api request is served by the bundled local backend on 127.0.0.1, never a remote server. Callers pass
// the full URL (main.js resolves it) and keep their own timeouts and error handling; a URL that is not
// the local backend is refused before any request, as a rejected promise, the same shape a network
// failure has. The only other origin is the dev backend main.js registers in an unpackaged run that has
// no bundled binary (allowDevBackend); in a packaged build allowDevBackend refuses, whoever calls it.
// The UI server's /api proxy, which connects with node:http rather than fetch, takes its target from
// localBackendTarget: the same check, so this module is the one choke point.
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

/**
 * The backend URL to connect to, parsed, when it is the local backend (or the registered dev one); else null.
 * @param {unknown} url
 * @returns {URL | null}
 */
function localBackendTarget(url) {
  return isLocalBackend(url) ? new URL(String(url)) : null
}

/**
 * DEV ONLY: main.js's unpackaged branch, when it points the app at a dev backend instead. Registers
 * nothing unless the caller says the build is unpackaged (app.isPackaged false). True when registered.
 * @param {string} url
 * @param {{ isPackaged?: boolean }} [build]
 */
function allowDevBackend(url, { isPackaged } = {}) {
  if (isPackaged !== false) return false
  devOrigin = new URL(url).origin
  return true
}

module.exports = { backendFetch, allowDevBackend, localBackendTarget }
