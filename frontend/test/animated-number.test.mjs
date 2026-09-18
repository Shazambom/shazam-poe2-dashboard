// The board's prices count up from 0 when a card mounts (coming back to the Board tab), then roll
// between polls. Owner's call (2026-09-18): this polish was cut once in a "motion honesty" pass and
// asked back — this pins it so a future sweep can't quietly remove it again.
import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
const { default: AnimatedNumber, COUNT_UP_FROM } = await import('../src/lib/animatedNumber.js')

const fmt = (v) => v.toFixed(2)

test('a freshly mounted price paints at 0, not at its value — that is the count-up', () => {
  const html = renderToStaticMarkup(React.createElement(AnimatedNumber, { value: 3828, format: fmt }))
  assert.equal(COUNT_UP_FROM, 0)
  assert.match(html, />0\.00</, `first paint is the spring's start: ${html}`)
  assert.doesNotMatch(html, /3828/, 'the value is the spring TARGET, reached by animating, not the first paint')
})

test('the board tile uses it for the price, and it is the spring that starts at 0', () => {
  const board = readFileSync(new URL('../src/components/BoardView.jsx', import.meta.url), 'utf8')
  assert.match(board, /import AnimatedNumber from '\.\.\/lib\/animatedNumber\.js'/)
  assert.match(board, /<AnimatedNumber value=\{mid\} format=\{fmt\.rate\} \/>/)
  const src = readFileSync(new URL('../src/lib/animatedNumber.js', import.meta.url), 'utf8')
  assert.match(src, /useSpring\(COUNT_UP_FROM,/, 'the spring starts at COUNT_UP_FROM, not at `value`')
})
