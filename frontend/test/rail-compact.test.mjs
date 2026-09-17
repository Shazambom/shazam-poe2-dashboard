// The searches rail fits every control at its floor: below the compact breakpoint the header drops its
// redundant text (title, toggle label) rather than any button, so the floor can sit under the header's
// wide-state width. Geometry itself is verified by driving the app (CDP); this pins the contract in code.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const ROOT = new URL('../', import.meta.url).pathname
const css = readFileSync(`${ROOT}src/styles.css`, 'utf8')
const ws = readFileSync(`${ROOT}src/components/WorkspaceView.jsx`, 'utf8')
const toggle = readFileSync(`${ROOT}src/components/Toggle.jsx`, 'utf8')

test('rail floor and default are compact', () => {
  const m = ws.match(/RAIL_MIN = (\d+), RAIL_MAX = (\d+), RAIL_DEFAULT = (\d+)/)
  assert.ok(m, 'rail constants present')
  assert.ok(+m[1] <= 180, `floor ${m[1]} ≤ 180`)
  assert.ok(+m[3] <= 240, `default ${m[3]} ≤ 240`)
  assert.ok(+m[1] < +m[3] && +m[3] < +m[2])
})

test('the rail is a size container and the compact query hides only text, never buttons', () => {
  assert.match(css, /\.ws-rail\s*\{[^}]*container(-type)?:\s*(rail \/ )?inline-size/)
  const q = css.match(/@container rail \(max-width: (\d+)px\)\s*\{([^}]*\}\s*)+?\}/)
  assert.ok(q, 'compact container query present')
  assert.ok(+q[1] >= 250, 'breakpoint covers the wide header (≥250px)')
  const body = css.slice(q.index, q.index + q[0].length)
  assert.match(body, /\.ws-rail-head > b\s*\{\s*display:\s*none/)
  assert.match(body, /\.ws-rail-head \.toggle-label\s*\{\s*display:\s*none/)
  assert.doesNotMatch(body, /ws-icon-btn|ws-mini|\.toggle\s*\{/)
})

test('the drag clamp re-measures the header on every move (compact header lowers the floor mid-drag)', () => {
  const onMove = ws.slice(ws.indexOf('const onMove = (ev) =>'), ws.indexOf('const onUp = () =>'))
  assert.match(onMove, /headMinWidth\(railHead\.current\)/)
  // scrollWidth is never a floor: the spacer makes it equal the current width, which pins the rail.
  assert.doesNotMatch(ws, /railHead\.current\?\.scrollWidth/)
  assert.match(ws, /function headMinWidth[\s\S]*?classList\.contains\('spacer'\)/)
})

test('the divider enters the resizing state on mousedown, before the first move', () => {
  const down = ws.slice(ws.indexOf('const onDividerDown'), ws.indexOf('const onMove = (ev) =>'))
  assert.match(down, /setDragWidth\(w0\)/)
})

test('Toggle carries an accessible name when its label is hidden', () => {
  assert.match(toggle, /aria-label=\{ariaLabel/)
  assert.match(ws, /label="EE2"[^>]*ariaLabel=/)
})
