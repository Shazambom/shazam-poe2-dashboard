// The report body: gzip(JSON { manifest, state, logs, screens }). Everything is injected (the
// fetcher, the desktop-settings reader, the log sources, the screens) so this runs in tests with no
// Electron and no network. State comes from four credential-free endpoints only — never
// /api/session or /api/oauth/* — then the allow-list and redactDeep run over state + logs.
'use strict'
const { gzipSync, constants } = require('zlib')
const { SETTINGS_KEYS, pickAllowed, redactDeep } = require('./redact.js')

const STATE_ENDPOINTS = ['/api/diag', '/api/status', '/api/backfill', '/api/settings']
const MAX_BUNDLE = 4 * 1024 * 1024 - 65        // the sealed file stays under Discord's cap with room to spare
const LIMITS = { main: 200, backend: 65536, renderer: 100, updater: 40 }
const GZIP = { level: constants.Z_BEST_COMPRESSION }

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))])

async function fetchState(get, timeoutMs) {
  const out = {}
  for (const p of STATE_ENDPOINTS) {
    const k = p.slice(5)   // '/api/diag' → 'diag'
    try { out[k] = await withTimeout(Promise.resolve().then(() => get(p)), timeoutMs) }
    catch (e) { out[k] = { error: String(e && e.message || e) } }
  }
  return out
}

function logsFrom(sources = {}) {
  const tail = (a, n) => (Array.isArray(a) ? a : []).slice(-n).map(String)
  return {
    main: tail(sources.main, LIMITS.main),
    backend: String(sources.backend || '').slice(-LIMITS.backend),
    renderer: tail(sources.renderer, LIMITS.renderer),
    updater: tail(sources.updater, LIMITS.updater),
  }
}

// Screens are already JPEG buffers; encode them, and if the whole bundle would blow the cap drop
// the largest ones until it fits. Size never fails a report.
function pack(doc, screens) {
  const remaining = new Map(Object.entries(screens || {}).filter(([, b]) => b && b.length))
  let partial = false
  for (;;) {
    doc.screens = Object.fromEntries([...remaining].map(([k, b]) => [k, Buffer.from(b).toString('base64')]))
    doc.manifest.screensPartial = partial
    const gz = gzipSync(Buffer.from(JSON.stringify(doc)), GZIP)
    if (gz.length <= MAX_BUNDLE || remaining.size === 0) return gz
    const biggest = [...remaining].sort((a, b) => b[1].length - a[1].length)[0][0]
    remaining.delete(biggest)
    partial = true
  }
}

async function buildBundle({ meta, sources, get, readJson, bounds, screens, timeoutMs = 4000 }) {
  const state = await fetchState(get, timeoutMs)
  state.settings = pickAllowed(state.settings, SETTINGS_KEYS)
  let desktop = {}
  try { desktop = readJson() || {} } catch {}
  state.desktopSettings = pickAllowed(desktop, SETTINGS_KEYS)
  state.bounds = bounds || null
  const doc = {
    manifest: { v: 1, ...meta, screensPartial: false },
    state: redactDeep(state),
    logs: redactDeep(logsFrom(sources)),
    screens: {},
  }
  return pack(doc, screens)
}

module.exports = { buildBundle, STATE_ENDPOINTS, MAX_BUNDLE, LIMITS }
