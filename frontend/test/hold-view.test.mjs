// Hold (first-contact audit, 2026-10-08): UI only. The row gets a Price column by the volume rule (the backend's
// price/price_cur, raw, with its currency); the pills say one thing each (buy: the day; sell: the day and the gain). The ranking and every number behind it are untouched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const hold = readFileSync(new URL('../src/components/HoldView.jsx', import.meta.url), 'utf8')
const arc = readFileSync(new URL('../src/components/LeagueArc.jsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('the Hold table shows a Price column in the market that trades the asset', () => {
  const start = hold.indexOf('<thead>'); const table = hold.slice(start, hold.indexOf('</table>', start))
  assert.match(table, /<th[^>]*>Price<\/th>/)
  assert.match(table, /r\.price_cur/)
  assert.match(table, /Max dip/)
  assert.doesNotMatch(table, /Max drawdown/)
})

test('a buy pill names the day; a sell pill the day and the gain; sell is gold, not red', () => {
  assert.match(arc, /kind === 'sell'/)
  const sell = css.slice(css.indexOf('.arc-win.sell'), css.indexOf('.arc-win.sell') + 160)
  assert.match(sell, /--gold/)
  assert.doesNotMatch(sell, /--loss/)
})
