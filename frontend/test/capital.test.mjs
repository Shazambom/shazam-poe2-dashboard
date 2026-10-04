// A holding's worth by the volume rule (CLAUDE.md): cash is its own raw amount (already in the quantity
// field, so no worth); anything else is worth its quantity at the rate of the market that trades it.
import test from 'node:test'
import assert from 'node:assert/strict'
const { holdingWorth } = await import('../src/lib/capital.js')

test('a cash holding has no worth line: its quantity is the native amount', () => {
  const v = { currency: 'divine', qty: 603, value_ref: 303802, native: { amount: 603, cur: 'divine' } }
  assert.equal(holdingWorth(v), null)
})

test('a traded holding is worth its market rate, with its reference value for the readable fallback', () => {
  const v = { currency: 'vaal', qty: 40, value_ref: 276.9, native: { amount: 276.9, cur: 'exalted' } }
  assert.deepEqual(holdingWorth(v), { amount: 276.9, cur: 'exalted', ref: 276.9 })
})

test('no worth without a value, without a market rate, or while the market syncs', () => {
  assert.equal(holdingWorth({ currency: 'x', qty: 1, value_ref: null }), null)
  assert.equal(holdingWorth({ currency: 'x', qty: 1, value_ref: 5, native: null }), null)
  assert.equal(holdingWorth({ currency: 'vaal', qty: 1, value_ref: 7, native: { amount: 7, cur: 'exalted' } }, { syncing: true }), null)
})

test('the Stash renders each holding natively, the totals as the one approximation', async () => {
  const { readFileSync } = await import('node:fs')
  const s = readFileSync(new URL('../src/components/StashView.jsx', import.meta.url), 'utf8')
  assert.ok(s.includes('holdingWorth(') && s.includes('<Native'), 'rows through holdingWorth + <Native>')
  assert.ok(!/<Wealth v=\{r\.(value_ref|realizable_ref)\}/.test(s), 'no re-denominated holding')
  assert.ok(s.includes('<Wealth v={total}') && s.includes('<Wealth v={liquid}'), 'net worth and liquid net worth are wealth figures')
})

// Startup after an update (or a long break): the graph has no markets until the digest sync
// catches up, and the backend says `syncing` instead of judging holdings. The card waits ("…")
// and the poll comes back in seconds, not 30 s, so it never shows a no-market judgment.
test('while syncing a holding has no line yet; the poll comes back fast until it clears', async () => {
  const { nextPollMs, SYNC_POLL_MS } = await import('../src/lib/capital.js')
  const v = { currency: 'vaal', qty: 40, value_ref: 280, native: { amount: 280, cur: 'exalted' } }
  assert.equal(holdingWorth(v, { syncing: true }), null)
  assert.notEqual(holdingWorth(v), null, 'outside syncing the same row has its worth')
  assert.equal(SYNC_POLL_MS, 3000)
  assert.equal(nextPollMs({ syncing: true }, 30000), 3000)
  assert.equal(nextPollMs({ syncing: false }, 30000), 30000)
  assert.equal(nextPollMs(null, 30000), 30000)
})

test('the card and the poll read the syncing flag', async () => {
  const { readFileSync } = await import('node:fs')
  const card = readFileSync(new URL('../src/components/StashView.jsx', import.meta.url), 'utf8')
  const store = readFileSync(new URL('../src/lib/statusStore.js', import.meta.url), 'utf8')
  assert.ok(card.includes('data?.syncing'), 'the Stash reads the payload flag')
  assert.ok(store.includes('nextPollMs('), 'the status poll schedules by it')
})
