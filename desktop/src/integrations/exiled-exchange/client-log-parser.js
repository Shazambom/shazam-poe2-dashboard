// Parser for Path of Exile 2 Client.txt lines (pure: parseLine(line) → typed event or null).
// Pairs with log-watcher.js. Only safe non-chat events cross IPC to the renderer (toRendererEvent).
//
//   2026/09/16 21:03:11 123456789 1a2b3c4d [INFO Client 4321] @From Trader_One: hi               → whisper-in
//   … @To Buyer_Two: sure                                                                         → whisper-out
//   … : You have entered The Ziggurat Refuge.                                                     → zone
//   … Generating level 80 area "MapCrypt" with seed 123456789                                     → area-gen
//   … : Trade accepted. / : Trade cancelled.                                                      → trade-accepted / trade-cancelled
//   … : AFK mode is now ON. Autoreply "brb" / : AFK mode is now OFF.                              → afk-on / afk-off
'use strict'

const HEAD = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) \d+ [0-9a-f]+ \[[^\]]*\]$/
const WHISPER = /^@(From|To) (?:<[^>]+> )?([^:]+?): (.*)$/
const ZONE = /^: You have entered (.+)\.$/
const AREA_GEN = /^Generating level (\d+) area "([^"]+)" with seed (\d+)$/
const TRADE = /^: Trade (accepted|cancelled)\.$/
const AFK = /^: AFK mode is now (ON|OFF)\./

const RENDERER_EVENT_TYPES = new Set(['area-gen', 'zone', 'afk-on', 'afk-off'])

// The event a ': …' system line describes (zone, AFK, trade), tried in that order, or null.
function colonEvent(body) {
  const zone = ZONE.exec(body)
  if (zone) return { type: 'zone', zone: zone[1] }
  const afk = AFK.exec(body)
  if (afk) return { type: afk[1] === 'ON' ? 'afk-on' : 'afk-off' }
  const trade = TRADE.exec(body)
  if (trade) return { type: trade[1] === 'accepted' ? 'trade-accepted' : 'trade-cancelled' }
  return null
}

function parseLine(line) {
  if (typeof line !== 'string') return null
  const trimmed = line.trim()
  const sep = trimmed.indexOf('] ')
  if (sep < 24) return null
  const body = trimmed.slice(sep + 2)
  const ch = body.charCodeAt(0)
  // Fast reject: only ':', '@', or 'G' (Generating level ...) can ever match an event.
  if (ch !== 58 && ch !== 64 && ch !== 71) return null
  /** @type {null | { type: string, ts?: number, [field: string]: any }} */
  let ev = null
  if (ch === 58) {
    ev = colonEvent(body)
  } else if (ch === 71) {
    const gen = AREA_GEN.exec(body)
    if (gen) ev = { type: 'area-gen', level: Number(gen[1]), areaId: gen[2], seed: gen[3] }
  } else {
    const whisper = WHISPER.exec(body)
    if (whisper) ev = { type: whisper[1] === 'From' ? 'whisper-in' : 'whisper-out', name: whisper[2].trim(), text: whisper[3] }
  }
  if (!ev) return null
  const m = HEAD.exec(trimmed.slice(0, sep + 1))
  if (!m) return null
  ev.ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime()   // Client.txt stamps local time
  return ev
}

// Allowlist for IPC to the renderer: never forwards whisper text, player names, or trade chat.
function toRendererEvent(ev) {
  return ev && RENDERER_EVENT_TYPES.has(ev.type) ? ev : null
}

module.exports = { parseLine, toRendererEvent }
