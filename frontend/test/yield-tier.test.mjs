// Yield as a tier badge (owner, 2026-10-08: "players know what a tier list is"). A loop's yield (velocity: profit
// per hour per 1k gold) is placed among the loops on screen: S near the best, then A, B, C. Bands are code
// constants relative to the list shown, so there is always an S; the ranking still uses the real value.
import test from 'node:test'
import assert from 'node:assert/strict'
import { yieldTiers, TIER_SHARES } from '../src/lib/yieldTier.js'

test('tiers are the share of the best loop on the list', () => {
  assert.deepEqual(TIER_SHARES, { S: 0.8, A: 0.5, B: 0.2 })
  assert.deepEqual(yieldTiers([10, 9, 5, 2, 1]), ['S', 'S', 'A', 'B', 'C'])
})

test('one loop is S; a free-gold loop is S without squashing the rest; an unknown yield has no tier', () => {
  assert.deepEqual(yieldTiers([3]), ['S'])
  assert.deepEqual(yieldTiers([Infinity, 4, 1, null]), ['S', 'S', 'B', null])
})

test('a list of negative yields still ranks from its best to its worst', () => {
  // the first-contact drive: -34.2 (best), -48.1, -69.3
  assert.deepEqual(yieldTiers([-48.1, -34.2, -69.3]), ['A', 'S', 'C'])
})

test('negative loops under a positive best are C', () => {
  assert.deepEqual(yieldTiers([2, -1]), ['S', 'C'])
})
