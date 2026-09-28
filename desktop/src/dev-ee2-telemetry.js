// DEV DIAGNOSTIC — reports EE2 integration hook events to the shazam dev server (on the owner's
// LAN) so the developer can see, remotely, what the hooks did on the user's machine. It lives
// OUTSIDE the integration package on purpose (the package stays strictly local, see its CLAUDE.md).
// Everything goes through telemetry.installLog(), which is beta/dev-gated: a stable build never posts.
//
// Three markers: `ee2` (compact event lines), `ee2-item` (the item text EE2 read, with the path it
// came in on: price check, clipboard add, Mods paste) and `ee2-query` (the history search URL the
// worker built). ops/pull-ee2-items.sh pulls the last two into local files.
'use strict'

const { installLog } = require('./telemetry.js')
const { queryUrl } = require('./trade/urls.js')

const ITEM_MARKER = 'ee2-item'
const QUERY_MARKER = 'ee2-query'
const ITEM_MAX = 8200      // clipboard-add's MAX_CLIP plus the origin line; the server keeps 20 000
const QUERY_MAX = 12000    // a built query is a few KB of JSON, URL-encoded

const post = (line, send = installLog) => send('ee2', String(line).slice(0, 500))

function postItemText(origin, raw, send = installLog) {
  if (typeof raw !== 'string' || !raw) return
  send(ITEM_MARKER, `origin=${origin}\n${raw}`, { max: ITEM_MAX })
}

function postQuery(intent, send = installLog) {
  if (!intent || !intent.q || intent.degraded) return
  send(QUERY_MARKER, `origin=${intent.origin} name="${String(intent.name || '').slice(0, 60)}"\n${queryUrl({ q: intent.q }, intent.cfgLeague)}`, { max: QUERY_MAX })
}

// Attach to the integration manager's event bus and forward the diagnostics.
function attachEe2Telemetry(manager, { send = installLog } = {}) {
  // telemetry.js prefixes `v<version> <platform>` on every line — no local tag.
  post('ee2-telemetry attached', send)
  manager.on('ee2-detected', (i) => post(`ee2-detected present=${i.present} method=${i.method} running=${i.running}`, send))
  manager.on('ee2-missing', () => post(`ee2-missing`, send))
  manager.on('started', () => post(`started`, send))
  manager.on('stopped', () => post(`stopped`, send))
  manager.on('error', (e) => post(`error ${String(e && e.message || e).slice(0, 160)}`, send))
  manager.on('ee2-hotkey', (h) => post(`ee2-hotkey action=${h.action} shortcut="${h.shortcut}"`, send))
  manager.on('item-checked', (it) => {
    post(`item-checked origin=${it.origin} rarity=${it.rarity} name="${String(it.name).slice(0, 40)}"`, send)
    postItemText(it.origin || 'ee2', it.raw, send)
  })
  return () => {}   // manager.stop() removes listeners; nothing extra to detach
}

module.exports = { attachEe2Telemetry, postItemText, postQuery, ITEM_MARKER, QUERY_MARKER, ITEM_MAX, QUERY_MAX }
