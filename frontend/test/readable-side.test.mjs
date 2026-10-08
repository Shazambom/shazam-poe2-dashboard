// Owner, 2026-10-08: "follow the volume rule and then apply readable side to the volume rule". The backend
// names the market (the busiest one); the view shows whichever side of that market reads >= 1: "0.018 Divine"
// is drawn as "55 per Divine". One helper decides, one element draws it, at every price site.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readable, flipChange } from '../src/lib/price.js'

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')

test('readable(): a rate >= 1 is shown as is; below 1 the other side of the market, "per"', () => {
  assert.deepEqual(readable(55), { n: 55, per: false })
  assert.deepEqual(readable(1), { n: 1, per: false })
  assert.deepEqual(readable(0.02), { n: 50, per: true })
  assert.deepEqual(readable(1 / 749.3), { n: 749.3, per: true })
  assert.deepEqual(readable(null), { n: null, per: false })
  assert.deepEqual(readable(0), { n: 0, per: false })
})

test('a flipped series flips its % change exactly: +25% on one side is -20% on the other', () => {
  assert.ok(Math.abs(flipChange(25) + 20) < 1e-9)
  assert.ok(Math.abs(flipChange(-20) - 25) < 1e-9)
  assert.equal(flipChange(0), -0)
  assert.equal(flipChange(null), null)
})

test('one element draws every price: Board tiles and hubs, the card, Hold, the inbox', () => {
  assert.match(src('components/Rate.jsx'), /readable\(/)
  for (const f of ['components/BoardView.jsx', 'components/CardDetail.jsx', 'components/HoldView.jsx', 'components/DivinePingOrb.jsx', 'components/ModSection.jsx']) {
    const s = src(f)
    assert.match(s, /<Rate /, `${f} draws prices with <Rate>`)
    assert.doesNotMatch(s, /fmt\.rate\(/, `${f} no longer formats a price by hand`)
  }
  assert.doesNotMatch(src('components/HoldView.jsx'), /fmt\.n\(r\.price/)
})

test('a flipped card flips its line and its %: the tile and the card detail', () => {
  for (const f of ['components/BoardView.jsx', 'components/CardDetail.jsx']) {
    const s = src(f)
    assert.match(s, /flipChange\(/, `${f}`)
    assert.match(s, /1 \/ p\.v/, `${f} inverts the points`)
  }
})
