// DORMANT — not wired; reserved for future feature work (whisper pings, hideout arrival,
// trade-done). Nothing planned.
//
// Our own parser for the handful of Path of Exile 2 Client.txt lines a future feature could act on
// (EE2's client-log-parser.ts is reference only; this is original code). Pure: parseLine(line) →
// a typed event or null. Pairs with log-watcher.js (the equally unwired tailer); neither is
// required by main.js or the package index — a test asserts that.
//
//   2026/09/16 21:03:11 123456789 1a2b3c4d [INFO Client 4321] @From Trader_One: hi   → whisper-in
//   … @To Buyer_Two: sure                                                            → whisper-out
//   … : You have entered The Ziggurat Refuge.                                        → zone
//   … : Trade accepted. / : Trade cancelled.                                         → trade-accepted / trade-cancelled
//   … : AFK mode is now ON. Autoreply "brb" / : AFK mode is now OFF.                 → afk-on / afk-off
'use strict'

const DORMANT = 'DORMANT — not wired; reserved for future feature work (whisper pings, hideout arrival, trade-done). Nothing planned.'

const HEAD = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) \d+ [0-9a-f]+ \[[^\]]*\] (.*)$/
const WHISPER = /^@(From|To) (?:<[^>]+> )?([^:]+?): (.*)$/
const ZONE = /^: You have entered (.+)\.$/
const TRADE = /^: Trade (accepted|cancelled)\.$/
const AFK = /^: AFK mode is now (ON|OFF)\./

function parseLine(line) {
  if (typeof line !== 'string') return null
  const m = HEAD.exec(line.trim())
  if (!m) return null
  const ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()   // Client.txt stamps local time
  const body = m[7]
  let w
  if ((w = WHISPER.exec(body))) return { type: w[1] === 'From' ? 'whisper-in' : 'whisper-out', name: w[2].trim(), text: w[3], ts }
  if ((w = ZONE.exec(body))) return { type: 'zone', zone: w[1], ts }
  if ((w = TRADE.exec(body))) return { type: w[1] === 'accepted' ? 'trade-accepted' : 'trade-cancelled', ts }
  if ((w = AFK.exec(body))) return { type: w[1] === 'ON' ? 'afk-on' : 'afk-off', ts }
  return null
}

module.exports = { parseLine, DORMANT }
