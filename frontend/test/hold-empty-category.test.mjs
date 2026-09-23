// Reproduction from the 2026-09-23 review. An empty CATEGORY is not a missing backfill: the page
// must not tell the user a crawl is running when nothing in that category qualifies today.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/components/HoldView.jsx', import.meta.url), 'utf8')

test('the backfill wording is reserved for the whole-universe empty board', () => {
  const backfill = src.indexOf('No assets scored yet')
  assert.ok(backfill > 0, 'the whole-board empty message still exists')
  const line = src.slice(src.lastIndexOf('\n', backfill), src.indexOf('\n', backfill))
  assert.match(line, /category === 'all'/, `the backfill message is shown for any category: ${line.trim()}`)
})

test('an empty category tells the user to pick another one', () => {
  assert.match(src, /category !== 'all'[^\n]*pick another category/i, 'no category-specific empty message')
})
