// A dropdown (CurrencyPicker's list) opens toward the room: below when its list fits there, else
// toward whichever side has more space, so it is never cut off at the bottom of a scrolling page.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const { opensUp } = await import('../src/lib/dropdown.js')

test('below when the list fits below; above only when below is short and above has more room', () => {
  assert.equal(opensUp({ below: 500, above: 100, need: 380 }), false, 'fits below: below')
  assert.equal(opensUp({ below: 120, above: 600, need: 380 }), true, 'cut off below, room above: above')
  assert.equal(opensUp({ below: 200, above: 150, need: 380 }), false, 'short both ways: the roomier side (below)')
  assert.equal(opensUp({ below: 150, above: 200, need: 380 }), true)
})

test('the picker measures the room when it opens and flips its list', () => {
  const src = readFileSync(new URL('../src/components/CurrencyPicker.jsx', import.meta.url), 'utf8')
  assert.ok(src.includes('opensUp(') && src.includes("curpick-pop ${up ? 'up' : ''}"))
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  assert.ok(/\.curpick-pop\.up \{[^}]*bottom: calc\(100% \+/.test(css), 'an upward list sits above the box')
})

test('the calculator fills the window under its tabs: no short box with empty space below', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  assert.ok(/\.workspace\.scalc \{[^}]*flex: 1[^}]*min-height: 0/.test(css))
})

test('the room a list needs is its own max height, read from the page, not a copied 44%', () => {
  const src = readFileSync(new URL('../src/components/CurrencyPicker.jsx', import.meta.url), 'utf8')
  assert.ok(src.includes('getComputedStyle(pop).maxHeight') && !src.includes('0.44'))
})
