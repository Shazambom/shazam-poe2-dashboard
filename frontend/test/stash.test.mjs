// Trading → Stash (owner, 2026-10-03): holdings grouped by the game's own category (the server's
// `group` per currency), two totals — net worth (every holding at paper) and liquid net worth (what
// the switched-on holdings would realize) — and a switch per holding and per group. Every currency
// counts until the user switches it off; that default is ONE constant so it can change later.
import test from 'node:test'
import assert from 'node:assert/strict'
const S = await import('../src/lib/stash.js')

const row = (currency, value_ref, realizable_ref = value_ref, extra = {}) => ({ currency, qty: 1, value_ref, realizable_ref, ...extra })
const GROUPS = { divine: 'Currency', chaos: 'Currency', 'omen-of-light': 'Abyss', 'omen-of-whittling': 'Ritual', 'preserved-cranium': 'Abyss' }

test('a holding counts by the user\'s switch, else by the one default the backend serves', () => {
  assert.equal(S.isCounted('vaal', {}, true), true)
  assert.equal(S.isCounted('vaal', { vaal: false }, true), false)
  assert.equal(S.isCounted('vaal', { vaal: true }, true), true)
  assert.equal(S.isCounted('vaal', null, true), true)
  assert.equal(S.isCounted('vaal', {}, false), false, 'flip the default on the backend and every unswitched holding follows')
  assert.equal(S.isCounted('vaal', { vaal: true }, false), true)
})

test('holdings group by the server\'s group, biggest group first, biggest holding first', () => {
  const rows = [row('chaos', 100), row('omen-of-light', 50), row('divine', 900), row('preserved-cranium', 300), row('omen-of-whittling', 20)]
  const gs = S.stashGroups(rows, GROUPS, {}, true)
  assert.deepEqual(gs.map(g => g.name), ['Currency', 'Abyss', 'Ritual'])
  assert.deepEqual(gs[0].rows.map(r => r.currency), ['divine', 'chaos'])
  assert.deepEqual(gs[1].rows.map(r => r.currency), ['preserved-cranium', 'omen-of-light'])
  assert.equal(gs[0].value_ref, 1000)
  assert.equal(gs[1].value_ref, 350)
})

test('a currency with no group yet lands in one "Other" group, never in a guessed one', () => {
  const gs = S.stashGroups([row('mystery', 5)], {}, {})
  assert.equal(gs.length, 1)
  assert.equal(gs[0].name, S.UNGROUPED)
})

test('a group\'s switch reads on, off or some, and its counted value is its switched-on holdings at paper', () => {
  const rows = [row('divine', 900, 900), row('chaos', 100, 90), row('omen-of-light', 50, 30)]
  const [cur, abyss] = S.stashGroups(rows, GROUPS, { chaos: false, 'omen-of-light': false }, true)
  assert.equal(cur.counted, 'some')
  assert.equal(cur.counted_ref, 900)
  assert.equal(abyss.counted, false)
  assert.equal(abyss.counted_ref, 0)
  assert.equal(S.stashGroups(rows, GROUPS, {}, true)[0].counted, true)
})

test('liquid net worth = realizable value of the switched-on holdings; net worth counts every holding', () => {
  const rows = [row('divine', 900, 880), row('chaos', 100, 90), row('omen-of-light', 50, null)]
  assert.equal(S.netWorth(rows), 1050)
  assert.equal(S.liquidNetWorth(rows, {}, true), 970, 'a holding with no cash-out adds nothing liquid')
  assert.equal(S.liquidNetWorth(rows, { divine: false }, true), 90)
  assert.equal(S.netWorth([row('x', null)]), 0)
})

test('flipping a group switches every holding in it: on when any is off, otherwise off', () => {
  const rows = [row('divine', 900), row('chaos', 100)]
  const [mixed] = S.stashGroups(rows, GROUPS, { chaos: false }, true)
  assert.deepEqual(S.flipGroup(mixed), { divine: true, chaos: true })
  const [allOn] = S.stashGroups(rows, GROUPS, {}, true)
  assert.deepEqual(S.flipGroup(allOn), { divine: false, chaos: false })
})

test('a small group starts folded: under half a percent of net worth', () => {
  assert.equal(S.foldedByDefault({ value_ref: 4 }, 1000), true)
  assert.equal(S.foldedByDefault({ value_ref: 5 }, 1000), false)
  assert.equal(S.foldedByDefault({ value_ref: 0 }, 0), false, 'an empty stash folds nothing')
})

test('search matches a holding by name, case-insensitively; empty search matches all', () => {
  assert.equal(S.matches({ name: 'Omen of Light' }, 'light'), true)
  assert.equal(S.matches({ name: 'Omen of Light' }, 'divine'), false)
  assert.equal(S.matches({ name: 'Omen of Light' }, '  '), true)
})

test('the Arbitrage rail lists only held arbitrage capital, biggest first', () => {
  const capital = { rows: [row('vaal', 400, 400, { arbitrage: false }), row('chaos', 100, 100, { arbitrage: true }),
    row('divine', 900, 900, { arbitrage: true }), { currency: 'exalted', qty: 0, value_ref: 0, arbitrage: true }] }
  assert.deepEqual(S.arbitrageHoldings(capital).map(r => r.currency), ['divine', 'chaos'])
  assert.deepEqual(S.arbitrageHoldings(null), [])
})

test('a group\'s accent is a token named after the game\'s category, neutral when it has none', () => {
  assert.equal(S.groupAccent("Atziri's Temple"), 'var(--grp-atziri-s-temple, var(--muted))')
  assert.equal(S.groupAccent('Soul Cores'), 'var(--grp-soul-cores, var(--muted))')
})

// QA pass 1 (2026-10-03)
// A sale that costs more gold than it fetches realizes 0 — the backend's rule (liquidity.realizable,
// backend/tests/test_stash.py); the client sums what it is served.

test('a quantity is a whole, non-negative count', () => {
  assert.equal(S.cleanQty('42'), '42')
  assert.equal(S.cleanQty('-3'), '0')
  assert.equal(S.cleanQty('2.5'), '2')
  assert.equal(S.cleanQty(''), '', 'clearing the box is allowed while typing')
  assert.equal(S.cleanQty('abc'), '')
})

test('a cleared choice (a removed holding) falls back to the default', () => {
  assert.equal(S.isCounted('vaal', { vaal: null }, true), true)
})

// code review (2026-10-03)
test('folding is the stored choice; while searching a click changes nothing', () => {
  const g = { name: 'Currency', value_ref: 900 }
  assert.equal(S.isFolded(g, {}, 1000, ''), false)
  assert.equal(S.isFolded(g, { Currency: true }, 1000, ''), true)
  assert.equal(S.isFolded(g, { Currency: true }, 1000, 'div'), false, 'a search opens every matching group')
  assert.deepEqual(S.flipFold(g, {}, 1000, ''), { Currency: true })
  assert.deepEqual(S.flipFold(g, {}, 1000, 'div'), {}, 'no hidden fold saved mid-search')
})

test('a sale credited while edits are unsaved keeps both: the credit is added to what was typed', () => {
  const basis = { rows: [{ currency: 'divine', qty: 10 }, { currency: 'chaos', qty: 5 }] }
  const post = { rows: [{ currency: 'divine', qty: 13 }, { currency: 'chaos', qty: 5 }, { currency: 'vaal', qty: 2 }] }
  const typed = { divine: '11', chaos: '7', exalted: '0' }
  assert.deepEqual(S.applyCredit(typed, basis, post), { divine: '14', chaos: '7', exalted: '0', vaal: '2' })
  assert.deepEqual(S.applyCredit(typed, post, post), typed, 'no credit, nothing changes')
})

// Owner (2026-10-03): "move add currency to the top of the stash tab and keep it there … a box next to it to
// decide how much to add and a button to add the currently selected currency + the amount".
test('adding an amount puts a new currency in, or adds to one already held', () => {
  const qty = { divine: '1132', chaos: '0' }
  assert.deepEqual(S.addAmount(qty, 'divine', 5), { divine: '1137', chaos: '0' })
  assert.deepEqual(S.addAmount(qty, 'vaal', 3), { divine: '1132', chaos: '0', vaal: '3' })
  assert.deepEqual(S.addAmount(qty, 'chaos', 2), { divine: '1132', chaos: '2' })
  assert.equal(S.addAmount(qty, 'vaal', 0), qty, 'nothing to add: unchanged')
  assert.equal(S.addAmount(qty, '', 3), qty, 'no currency picked: unchanged')
  assert.equal(S.addAmount(qty, 'vaal', -2), qty, 'never a negative amount')
  assert.deepEqual(S.addAmount({ divine: '' }, 'divine', 4), { divine: '4' }, 'a cleared box counts as 0')
})

test('the amount to add reads what people type: 40k, 1,000, 3*12', () => {
  assert.equal(S.parseAmount('5'), 5)
  assert.equal(S.parseAmount('40k'), 40000)
  assert.equal(S.parseAmount('1,000'), 1000)
  assert.equal(S.parseAmount('3*12'), 36)
  assert.equal(S.parseAmount('2.5'), 2, 'whole counts')
  assert.equal(S.parseAmount('-3'), null)
  assert.equal(S.parseAmount(''), null)
  assert.equal(S.parseAmount('abc'), null)
})
