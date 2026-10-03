// Every text box selects its whole contents when it is clicked into, so a new value replaces the old one
// without highlighting and deleting it first (owner, 2026-10-02: "It should be auto-highlighting"). One
// document-level rule, not a handler per box. A click into a box that already has focus places the caret
// as usual; the click that focuses a box must not have its mouseup collapse the selection (Chromium does).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
const { installSelectOnFocus, selectable } = await import('../src/lib/selectOnFocus.js')

const box = (tag, type, extra = {}) => ({ tagName: tag, type, selected: 0, select() { this.selected++ }, ...extra })

function fakeDoc() {
  const on = {}
  const doc = {
    activeElement: null,
    addEventListener: (t, f, capture) => { assert.equal(capture, true, `${t} listens in the capture phase`); (on[t] ||= []).push(f) },
    removeEventListener: (t, f) => { on[t] = (on[t] || []).filter(g => g !== f) },
  }
  const fire = (t, target) => {
    let prevented = false
    for (const f of on[t] || []) f({ target, preventDefault: () => { prevented = true } })
    return prevented
  }
  // a mouse click: mousedown, the box takes focus, mouseup
  const click = (el) => {
    fire('mousedown', el)
    if (doc.activeElement !== el) { doc.activeElement = el; fire('focusin', el) }
    return fire('mouseup', el)
  }
  fakeDoc.registry.set(doc, on)
  return { doc, fire, click, on }
}
fakeDoc.registry = new Map()
fakeDoc.on = (doc) => fakeDoc.registry.get(doc)

test('text, number, search, password boxes and textareas are text boxes; toggles and pickers are not', () => {
  for (const t of ['text', 'number', 'search', 'password', 'url', 'email', 'tel', '']) assert.ok(selectable(box('INPUT', t)), t || 'no type')
  assert.ok(selectable(box('TEXTAREA', 'textarea')))
  for (const t of ['checkbox', 'radio', 'file', 'range', 'color', 'button', 'submit', 'date']) assert.ok(!selectable(box('INPUT', t)), t)
  assert.ok(!selectable(box('BUTTON', 'button')))
  assert.ok(!selectable(box('INPUT', 'text', { disabled: true })), 'a disabled box')
  assert.ok(!selectable(null))
})

test('clicking into a box selects everything in it, and the mouseup does not undo it', () => {
  const { doc, click } = fakeDoc()
  installSelectOnFocus(doc)
  const a = box('INPUT', 'number')
  assert.equal(click(a), true, 'the focusing click keeps its selection')
  assert.equal(a.selected, 1)
})

test('a second click inside a focused box just places the caret', () => {
  const { doc, click } = fakeDoc()
  installSelectOnFocus(doc)
  const a = box('INPUT', 'text')
  click(a)
  assert.equal(click(a), false)
  assert.equal(a.selected, 1, 'not selected again')
})

test('keyboard and programmatic focus (Tab, autoFocus) select too; non-text controls are untouched', () => {
  const { doc, fire, click } = fakeDoc()
  installSelectOnFocus(doc)
  const a = box('INPUT', 'text')
  fire('focusin', a)
  assert.equal(a.selected, 1)
  const cb = box('INPUT', 'checkbox')
  assert.equal(click(cb), false, 'a checkbox click is never prevented')
  assert.equal(cb.selected, 0)
})

// The partial highlight (owner, 2026-10-03: "sometimes when I click on a box that holds value it only
// partially highlights the text"): the browser's own mousedown places the caret and starts a drag
// selection, so a pointer that drifts a pixel before release replaced the select-all with a partial
// one (measured in the app: still click → "379", 1px drift → "", 4px drift → "3"). The press that
// focuses a box is the rule's: the browser default is cancelled, the box focused and fully selected.
function browser() {
  const { doc, fire } = fakeDoc()
  // a mouse press as Chromium does it: unless cancelled, it focuses the box and anchors a drag there
  const press = (el, { button = 0 } = {}) => {
    let prevented = false
    for (const f of fakeDoc.on(doc).mousedown || []) f({ target: el, button, preventDefault: () => { prevented = true } })
    if (!prevented && doc.activeElement !== el) { doc.activeElement = el; fire('focusin', el) }
    return prevented
  }
  return { doc, fire, press }
}

test('the press that focuses a text box is the rule\'s: no caret, no drag, the box focused and all selected', () => {
  const { doc, press } = browser()
  installSelectOnFocus(doc)
  const a = box('INPUT', 'number', { focus() { doc.activeElement = this; fakeDoc.on(doc).focusin.forEach(f => f({ target: this })) } })
  assert.equal(press(a), true, 'the browser never anchors a drag selection on this press')
  assert.equal(doc.activeElement, a)
  assert.equal(a.selected, 1)
})

test('a press inside a focused box, a right click, and a checkbox keep the browser\'s own behaviour', () => {
  const { doc, press } = browser()
  installSelectOnFocus(doc)
  const a = box('INPUT', 'text', { focus() { doc.activeElement = this; fakeDoc.on(doc).focusin.forEach(f => f({ target: this })) } })
  press(a)
  assert.equal(press(a), false, 'already focused: place the caret, drag-select part of it')
  const b = box('INPUT', 'text', { focus() { throw new Error('a right click must not focus') } })
  assert.equal(press(b, { button: 2 }), false)
  assert.equal(press(box('INPUT', 'checkbox')), false)
})

test('uninstall removes every listener', () => {
  const { doc, on } = fakeDoc()
  const off = installSelectOnFocus(doc)
  off()
  assert.equal(Object.values(on).flat().length, 0)
})

test('the app installs it once, and no box carries its own select-on-focus handler', () => {
  const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8')
  assert.match(main, /installSelectOnFocus\(document\)/)
  const dir = new URL('../src/components/', import.meta.url)
  for (const f of readdirSync(dir).filter(f => f.endsWith('.jsx'))) {
    assert.doesNotMatch(readFileSync(new URL(f, dir), 'utf8'), /onFocus=\{e => e\.target\.select\(\)\}/, f)
  }
})
