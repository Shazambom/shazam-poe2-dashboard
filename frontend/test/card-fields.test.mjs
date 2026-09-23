// Cleanup from the 2026-09-23 review, pinned at the source (the repo's pattern for JSX).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')

test('the zoomed card no longer reads bid and ask it never drew', () => {
  const src = read('../src/components/CardDetail.jsx')
  assert.doesNotMatch(src, /r\.buy|r\.sell/, 'buy/sell are read into variables and never rendered')
  assert.doesNotMatch(src, /bid\/ask breakdown/, 'the header comment promises a bid/ask breakdown that does not exist')
})

test('the board tile no longer claims the zoomed card shows ask, bid and spread', () => {
  assert.doesNotMatch(read('../src/components/BoardView.jsx'), /Ask \/ bid \/ spread/)
})

test('the inactive-market spread input cannot take a value below 1', () => {
  const src = read('../src/components/ArbitrageAlgorithm.jsx')
  const line = src.split('\n').find(l => /set\('wide_spread'/.test(l)) || ''
  assert.match(line, /min="1"/, `wide_spread input: ${line.trim()}`)
  assert.doesNotMatch(src, /0 turns it off/, 'the tooltip still offers a value the input cannot take')
})
