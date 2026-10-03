// desktop/src/trade/tap.js: Electron's debugger listening to an embedded trade window (CDP Network domain
// only; owner, 2026-10-02). It reads the responses the page already received — its search, its listings'
// prices, the site's price-filter options — and passes on a projection with no account, stash, token or
// item data. It never sends anything but Network.enable / Network.getResponseBody: in the probe, a
// Page.reload sent to a webview reloaded the whole app. Any failure is silence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const T = require('../src/trade/tap.js')

const POE = 'https://www.pathofexile.com'
const SEARCH_URL = `${POE}/api/trade2/search/poe2/Forbidden%20Rites`
const BODY = { query: { status: { option: 'securable' }, type: 'Revelatory Wombgift' }, sort: { price: 'asc' } }
const SEARCH_RES = { id: 'Q1', complexity: 3, result: ['a', 'b', 'c'], total: 3, inexact: false }
const listing = (id, amount, currency) => ({ id, listing: { method: 'psapi', price: { type: '~b/o', amount, currency }, account: { name: 'SECRET#1' }, stash: { name: 'S' }, hideout_token: 'TOKEN', whisper: 'w' }, item: { name: 'Hidden', typeLine: 'T' } })
const FETCH_RES = { result: [listing('b', 17, 'chaos'), null, listing('a', 105, 'vaal')] }
const FILTERS_RES = { result: [
  { id: 'type_filters', filters: [{ id: 'category', option: { options: [{ id: null, text: 'Any' }] } }] },
  { id: 'trade_filters', filters: [{ id: 'price', option: { options: [{ id: null, text: 'Exalted Orb Equivalent' }, { id: 'chaos', text: 'Chaos Orb' }, { id: 'vaal', text: 'Vaal Orb' }] } }] },
] }

// A fake webContents + debugger: records every command, serves bodies by requestId.
function fakeContents({ id = 7, bodies = {}, attachThrows = false, bodyFails = new Set() } = {}) {
  const dbg = new EventEmitter()
  const commands = []
  dbg.attach = () => { if (attachThrows) throw new Error('already attached') ; dbg.attached = true }
  dbg.isAttached = () => !!dbg.attached
  dbg.sendCommand = async (method, params) => {
    commands.push(method)
    if (method === 'Network.getResponseBody') {
      if (bodyFails.has(params.requestId)) throw new Error('No resource with given identifier found')
      const b = bodies[params.requestId]
      return typeof b === 'string' ? { body: b, base64Encoded: false } : b
    }
    return {}
  }
  const contents = new EventEmitter()
  Object.assign(contents, { id, debugger: dbg, isDevToolsOpened: () => false })
  return { contents, dbg, commands }
}
const tick = () => new Promise(r => setImmediate(r))
const req = (dbg, requestId, url, method = 'GET', postData) => dbg.emit('message', {}, 'Network.requestWillBeSent', { requestId, request: { url, method, postData }, type: 'XHR' })
const done = (dbg, requestId) => dbg.emit('message', {}, 'Network.loadingFinished', { requestId })

function run(opts = {}, { reset = true } = {}) {
  if (reset) T._resetForTests()
  const f = fakeContents(opts)
  const sent = [], lines = []
  T.attachTap(f.contents, (ch, p) => sent.push([ch, p]), (l) => lines.push(l))
  return { ...f, sent, lines, events: () => sent.map(([, p]) => p) }
}

test('the page\'s search is passed on: its query, result order and total', async () => {
  const h = run({ bodies: { r1: JSON.stringify(SEARCH_RES) } })
  req(h.dbg, 'r1', SEARCH_URL, 'POST', JSON.stringify(BODY))
  done(h.dbg, 'r1'); await tick()
  assert.deepEqual(h.sent, [['trade:tap', { kind: 'search', wcId: 7, league: 'Forbidden Rites', id: 'Q1', body: BODY, ids: ['a', 'b', 'c'], total: 3 }]])
})

test('listings carry only id, amount and currency: no account, stash, token, whisper or item', async () => {
  const h = run({ bodies: { f1: JSON.stringify(FETCH_RES) } })
  req(h.dbg, 'f1', `${POE}/api/trade2/fetch/b,x,a?query=Q1&realm=poe2`)
  done(h.dbg, 'f1'); await tick()
  assert.deepEqual(h.events(), [{ kind: 'fetch', wcId: 7, searchId: 'Q1', rows: [{ id: 'b', amount: 17, currency: 'chaos' }, { id: 'a', amount: 105, currency: 'vaal' }] }])
  assert.doesNotMatch(JSON.stringify(h.sent), /SECRET|TOKEN|stash|whisper|Hidden/)
})

test('the site\'s price-filter options are passed on, and replayed to the next window that attaches', async () => {
  const h = run({ bodies: { d1: JSON.stringify(FILTERS_RES) } })
  req(h.dbg, 'd1', `${POE}/api/trade2/data/filters`)
  done(h.dbg, 'd1'); await tick()
  const opts = { kind: 'options', wcId: 7, price: [{ id: 'chaos', text: 'Chaos Orb' }, { id: 'vaal', text: 'Vaal Orb' }] }
  assert.deepEqual(h.events(), [opts])
  const next = run({ id: 9 }, { reset: false })        // a remounted window may serve data/filters from cache
  await tick()
  assert.deepEqual(next.events(), [{ ...opts, wcId: 9 }])
})

test('base64-encoded bodies are decoded', async () => {
  const h = run({ bodies: { r1: { body: Buffer.from(JSON.stringify(SEARCH_RES)).toString('base64'), base64Encoded: true } } })
  req(h.dbg, 'r1', SEARCH_URL, 'POST', JSON.stringify(BODY))
  done(h.dbg, 'r1'); await tick()
  assert.equal(h.events()[0].id, 'Q1')
})

test('it only ever sends Network.enable and Network.getResponseBody', async () => {
  const h = run({ bodies: { r1: JSON.stringify(SEARCH_RES), f1: JSON.stringify(FETCH_RES) } })
  req(h.dbg, 'r1', SEARCH_URL, 'POST', JSON.stringify(BODY)); done(h.dbg, 'r1')
  req(h.dbg, 'f1', `${POE}/api/trade2/fetch/b?query=Q1&realm=poe2`); done(h.dbg, 'f1')
  h.dbg.emit('detach', {}, 'canceled_by_user'); h.contents.emit('devtools-closed')
  await tick()
  assert.ok(h.commands.length >= 3)
  for (const c of h.commands) assert.ok(['Network.enable', 'Network.getResponseBody'].includes(c), c)
  assert.throws(() => T._send(h.dbg, 'Page.reload'), /not allowed/)
})

test('other pages, other hosts and the bulk exchange are ignored; their bodies are never read', async () => {
  const h = run({ bodies: {} })
  for (const [id, url] of [['x1', `${POE}/api/trade2/exchange/poe2/Standard`], ['x2', `${POE}/trade2/search/poe2/Standard`], ['x3', 'https://evil.example/api/trade2/search/poe2/X'], ['x4', `${POE}/api/trade2/data/static`]]) {
    req(h.dbg, id, url, 'POST', '{}'); done(h.dbg, id)
  }
  await tick()
  assert.deepEqual(h.sent, [])
  assert.deepEqual(h.commands, ['Network.enable'])
})

test('a body that cannot be read or parsed is silence, never a throw', async () => {
  const h = run({ bodies: { r2: 'not json' }, bodyFails: new Set(['r1']) })
  req(h.dbg, 'r1', SEARCH_URL, 'POST', JSON.stringify(BODY)); done(h.dbg, 'r1')
  req(h.dbg, 'r2', SEARCH_URL, 'POST', JSON.stringify(BODY)); done(h.dbg, 'r2')
  req(h.dbg, 'r3', SEARCH_URL, 'POST', 'garbage'); done(h.dbg, 'r3')
  await tick()
  assert.deepEqual(h.sent, [])
})

test('a remount (target closed) ends it; DevTools taking the slot re-attaches when DevTools closes', async () => {
  const h = run()
  let attaches = 0
  const orig = h.dbg.attach; h.dbg.attach = () => { attaches++; orig() }
  h.dbg.attached = false; h.dbg.emit('detach', {}, 'target closed'); h.contents.emit('devtools-closed')
  await tick()
  assert.equal(attaches, 0, 'a closed target is never re-attached')
  const g = run()
  let n = 0
  const o2 = g.dbg.attach; g.dbg.attach = () => { n++; o2() }
  g.dbg.attached = false; g.dbg.emit('detach', {}, 'canceled_by_user'); g.contents.emit('devtools-closed')
  await tick()
  assert.equal(n, 1)
})

test('a window it cannot attach to sends nothing and does not throw', () => {
  const h = run({ attachThrows: true })
  assert.deepEqual(h.sent, [])
  assert.match(h.lines.join('\n'), /attach-fail/)
})

test('main attaches the tap to every trade webview; the preload exposes it; telemetry goes through installLog', async () => {
  const { readFileSync } = await import('node:fs')
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  const hook = main.slice(main.indexOf("app.on('web-contents-created'"), main.indexOf("app.on('web-contents-created'") + 1500)
  assert.match(hook, /getType\(\) !== 'webview'\) return/)
  assert.match(hook, /attachTap\(contents, \(ch, p\) => win\?\.webContents\.send\(ch, p\), \(l\) => telemetry\.installLog\('tap', l\), require\('\.\/trade\/budget\.js'\)\.observe\)/)
  const pre = readFileSync(new URL('../src/preload.js', import.meta.url), 'utf8')
  assert.match(pre, /onTap: sub\('trade:tap'\)/)
})

// The budget can only protect the user if it sees the user's own browsing: the page's search and fetch responses
// carry the site's X-Rate-Limit headers, and the tap reports them under the matching policy (headers only, from the
// response the page already received; owner, 2026-10-03: "Yes we should consume the rate limit headers").
test('the page\'s own search/fetch rate-limit headers are reported to the budget; nothing else is', async () => {
  const f = fakeContents({ bodies: { r1: JSON.stringify(SEARCH_RES), f1: JSON.stringify(FETCH_RES) } })
  const seen = []
  T._resetForTests()
  T.attachTap(f.contents, () => {}, () => {}, (policy, status, headers) => seen.push([policy, status, Object.entries(headers).find(([k]) => k.toLowerCase() === 'x-rate-limit-account-state')?.[1]]))
  const res = (requestId, status, extra = {}) => f.dbg.emit('message', {}, 'Network.responseReceived', { requestId, response: { status, headers: { 'X-Rate-Limit-Rules': 'Account', 'X-Rate-Limit-Account-State': '3:4:0', ...extra } } })
  req(f.dbg, 'r1', SEARCH_URL, 'POST', JSON.stringify(BODY)); res('r1', 200)
  req(f.dbg, 'f1', `${POE}/api/trade2/fetch/b?query=Q1&realm=poe2`); res('f1', 429)
  req(f.dbg, 'd1', `${POE}/api/trade2/data/filters`); res('d1', 200)
  req(f.dbg, 'x1', `${POE}/trade2/search/poe2/Standard`); res('x1', 200)
  await tick()
  assert.deepEqual(seen, [['trade-search', 200, '3:4:0'], ['trade-fetch', 429, '3:4:0']])
})
