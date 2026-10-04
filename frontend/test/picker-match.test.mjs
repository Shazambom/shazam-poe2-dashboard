// The currency picker's search order (QA 2026-10-03: typing "vaal" put Vaal Orb sixth, behind five Vaal
// Infusers). An exact name first, then names that start with the text, then names containing it, then hidden
// keyword hits ("ruby" is the Ruby jewel before the Ruby Charm) — each in the list's own order.
import test from 'node:test'
import assert from 'node:assert/strict'
const { rankMatches } = await import('../src/lib/pickerMatch.js')

const O = (name, extra = {}) => ({ id: name.toLowerCase().replace(/\W+/g, '-'), name, ...extra })
const opts = [O("Vaal Armourer's Infuser"), O("Vaal Blacksmith's Infuser"), O('Vaal Cultivation Orb'), O('Ancient Vaal Relic'),
  O('Vaal Orb'), O('Ruby Charm', { keywords: ['ruby'] }), O('Ruby')]

test('an exact name comes first, then names starting with the text, then names containing it', () => {
  assert.deepEqual(rankMatches(opts, 'vaal orb').map(o => o.name), ['Vaal Orb'])
  assert.deepEqual(rankMatches(opts, 'vaal').map(o => o.name).slice(0, 5),
    ['Vaal Orb', 'Vaal Cultivation Orb', "Vaal Armourer's Infuser", "Vaal Blacksmith's Infuser", 'Ancient Vaal Relic'],
    'Vaal Orb is an exact id; then shorter prefix hits; contains-only last')
  assert.equal(rankMatches([...opts, O('Vaal')], 'vaal')[0].name, 'Vaal', 'the exact name leads')
  assert.deepEqual(rankMatches(opts, 'ruby').map(o => o.name), ['Ruby', 'Ruby Charm'])
  assert.equal(rankMatches(opts, 'vaal o')[0].name, 'Vaal Orb', 'the QA case: "vaal o" finds Vaal Orb first')
})

test('a blank search lists everything in its own order', () => {
  assert.deepEqual(rankMatches(opts, '  '), opts)
})

// code review 3: against the real list (sorted by name) "vaal" still put Vaal Orb sixth — every "Vaal …" name
// shares the prefix. An exact id ("vaal") ranks with an exact name; among prefix hits the shorter name leads.
test('typing "vaal" finds Vaal Orb first in the real list', () => {
  const real = ["Vaal Arcanist's Infuser", "Vaal Armourer's Infuser", "Vaal Blacksmith's Infuser", 'Vaal Catalysing Infuser',
    'Vaal Cultivation Orb', 'Vaal Orb', 'Vaal Siphoner'].map(n => O(n))
  real.find(o => o.name === 'Vaal Orb').id = 'vaal'
  assert.equal(rankMatches(real, 'vaal')[0].name, 'Vaal Orb', 'its id is exactly "vaal"')
  const noId = real.map(o => ({ ...o, id: o.name }))
  assert.deepEqual(rankMatches(noId, 'vaal').map(o => o.name).slice(0, 2), ['Vaal Orb', 'Vaal Siphoner'], 'shorter prefix hits first')
})
