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

test('every knob in the Arbitrage algorithm section is a bounded slider, never a number box', () => {
  // Owner (2026-09-23): "we don't want users inputting nonsense" — sliders, so the only values on
  // offer are the ones that mean anything. One shared Knob renders the range input with the gold
  // slider's classes; each use pins its own bounds.
  const src = read('../src/components/ArbitrageAlgorithm.jsx')
  assert.doesNotMatch(src, /type="number"/, 'a free number box is still there')
  assert.match(src, /type="range"[^\n]*min=\{min\}[^\n]*max=\{max\}[^\n]*step=\{step\}/, 'the shared Knob is not a bounded range input')
  assert.match(src, /gold-slider/, 'reuses the gold slider presentation, no new CSS')
  assert.doesNotMatch(src, /0 turns it off/)
  const want = {
    max_steps: { min: '2', max: '5', step: '1' },
    max_start_fraction: { min: '0.05', max: '1', step: '0.05' },
    step_overhead_min: { min: '0', max: '15', step: '0.5' },
    volume_window_h: { min: '1', max: '168', step: '1' },
    wide_spread: { min: '1', max: '5', step: '0.5' },
  }
  const knobs = src.split('<Knob').slice(1)
  for (const [key, r] of Object.entries(want)) {
    const knob = knobs.find(k => k.includes(`set('${key}'`)) || ''
    assert.ok(knob, `no Knob for ${key}`)
    for (const [k, v] of Object.entries(r)) assert.match(knob, new RegExp(`${k}="${v}"`), `${key}: ${k} should be ${v}`)
  }
  const weights = knobs.find(k => /setWeight\(/.test(k)) || ''
  assert.match(weights, /min="0"/); assert.match(weights, /max="1"/); assert.match(weights, /step="0.05"/)
})
