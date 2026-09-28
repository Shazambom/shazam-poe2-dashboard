// A Capital holding's line by the volume rule (CLAUDE.md): cash is its own raw amount (already in
// the quantity field, so no worth line); anything else is worth its quantity at its market's rate;
// a cash-out reads as the amount of the cash currency it ends in.
import test from 'node:test'
import assert from 'node:assert/strict'
const { holdingLine } = await import('../src/lib/capital.js')

test('a cash holding shows no worth line: its quantity is the native amount', () => {
  const v = { currency: 'divine', qty: 603, value_ref: 303802, realizable_ref: 303802, full_fill: true, source: 'cash',
    native: { amount: 603, cur: 'divine' }, realizable_native: { amount: 603, cur: 'divine' } }
  assert.deepEqual(holdingLine(v), { worth: null, cashout: null, ghostPct: 0, partial: false })
})

test('a traded holding is worth its market rate; its cash-out is the cash it ends in', () => {
  const v = { currency: 'vaal', qty: 40, value_ref: 276.9, realizable_ref: 249.0, full_fill: true, source: 'digest',
    native: { amount: 276.9, cur: 'exalted' }, realizable_native: { amount: 3.95, cur: 'chaos' } }
  const l = holdingLine(v)
  assert.deepEqual(l.worth, { amount: 276.9, cur: 'exalted', ref: 276.9 })
  assert.deepEqual(l.cashout, { amount: 3.95, cur: 'chaos', ref: 249.0 })
  assert.ok(Math.abs(l.ghostPct - (276.9 - 249.0) / 276.9 * 100) < 1e-9)
  assert.equal(l.partial, false)
})

test('a sale within a percent is no cash-out line; a partial fill always is; no market is none', () => {
  const base = { qty: 1, source: 'digest', native: { amount: 100, cur: 'exalted' }, realizable_native: { amount: 99.5, cur: 'exalted' } }
  assert.equal(holdingLine({ ...base, value_ref: 100, realizable_ref: 99.5, full_fill: true }).cashout, null)
  assert.equal(holdingLine({ ...base, value_ref: 100, realizable_ref: 60, full_fill: false }).partial, true)
  assert.deepEqual(holdingLine({ ...base, value_ref: 100, realizable_ref: null, realizable_native: null, full_fill: null }),
    { worth: { amount: 100, cur: 'exalted', ref: 100 }, cashout: null, ghostPct: 0, partial: false, noMarket: true })
  assert.equal(holdingLine({ qty: 1, value_ref: null }), null)
})

test('CapitalCard renders the holding line natively, the total as the one approximation', async () => {
  const { readFileSync } = await import('node:fs')
  const s = readFileSync(new URL('../src/components/CapitalCard.jsx', import.meta.url), 'utf8')
  assert.ok(s.includes('holdingLine(') && s.includes('<Native'), 'rows through holdingLine + <Native>')
  assert.ok(!s.includes('<Wealth v={v.value_ref}') && !s.includes('<Wealth v={v.realizable_ref}'), 'no re-denominated holding')
  assert.ok(s.includes('<Wealth v={data?.total_ref}'), 'the total stays one wealth figure')
})

// Startup after an update (or a long break): the graph has no markets until the digest sync
// catches up, and the backend says `syncing` instead of judging holdings. The card waits ("…")
// and the poll comes back in seconds, not 30 s, so it never shows a no-market judgment.
test('while syncing a holding has no line yet; the poll comes back fast until it clears', async () => {
  const { nextPollMs, SYNC_POLL_MS } = await import('../src/lib/capital.js')
  const v = { currency: 'chaos', qty: 212, value_ref: 13568, realizable_ref: null, native: null, realizable_native: null }
  assert.equal(holdingLine(v, { syncing: true }), null)
  assert.notEqual(holdingLine(v), null, 'outside syncing the same row is a no-market row')
  assert.equal(SYNC_POLL_MS, 3000)
  assert.equal(nextPollMs({ syncing: true }, 30000), 3000)
  assert.equal(nextPollMs({ syncing: false }, 30000), 30000)
  assert.equal(nextPollMs(null, 30000), 30000)
})

test('the card and the poll read the syncing flag', async () => {
  const { readFileSync } = await import('node:fs')
  const card = readFileSync(new URL('../src/components/CapitalCard.jsx', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../src/lib/statusStore.js', import.meta.url), 'utf8')
  assert.ok(card.includes('data?.syncing'), 'CapitalCard reads the payload flag')
  assert.ok(store.includes('nextPollMs('), 'the status poll schedules by it')
})
