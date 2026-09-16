// DORMANT infrastructure (roadmap 4-C): the Client.txt line grammar, pinned by fixtures; nothing wires it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { parseLine, DORMANT } = require('../src/integrations/exiled-exchange/client-log-parser.js')
const P = '2026/09/16 21:03:11 123456789 1a2b3c4d [INFO Client 4321] '

test('whispers, zone entry, trade outcome, AFK', () => {
  const ts = new Date(2026, 8, 16, 21, 3, 11).getTime()   // Client.txt stamps local time
  assert.deepEqual(parseLine(P + '@From Trader_One: Hi, I would like to buy your Headhunter'), { type: 'whisper-in', name: 'Trader_One', text: 'Hi, I would like to buy your Headhunter', ts })
  assert.equal(parseLine(P + '@From <GUILD> Trader_One: hi').name, 'Trader_One', 'guild tag stripped')
  assert.deepEqual(parseLine(P + '@To Buyer_Two: sure, one sec').type, 'whisper-out')
  assert.deepEqual(parseLine(P + ': You have entered The Ziggurat Refuge.'), { type: 'zone', zone: 'The Ziggurat Refuge', ts })
  assert.equal(parseLine(P + ': Trade accepted.').type, 'trade-accepted')
  assert.equal(parseLine(P + ': Trade cancelled.').type, 'trade-cancelled')
  assert.deepEqual(parseLine(P + ': AFK mode is now ON. Autoreply "brb"').type, 'afk-on')
  assert.equal(parseLine(P + ': AFK mode is now OFF.').type, 'afk-off')
})

test('everything else is null; malformed input never throws', () => {
  assert.equal(parseLine(P + ': Random chat line'), null)
  assert.equal(parseLine(''), null); assert.equal(parseLine(null), null); assert.equal(parseLine('garbage'), null)
})

test('it is dormant: marked, and never required by main.js or the package index', () => {
  assert.match(DORMANT, /DORMANT/)
  const ROOT = new URL('../../', import.meta.url).pathname
  for (const f of ['desktop/src/main.js', 'desktop/src/integrations/exiled-exchange/index.js', 'desktop/src/ee2-history/index.js']) assert.ok(!readFileSync(ROOT + f, 'utf8').includes('client-log-parser'), f)
  const src = readFileSync(ROOT + 'desktop/src/integrations/exiled-exchange/client-log-parser.js', 'utf8')
  assert.ok(src.includes('DORMANT — not wired'))
})
