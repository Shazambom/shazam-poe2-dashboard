// Every text box selects its whole contents when it takes focus (owner, 2026-10-02), so typing replaces
// the old value. One document-level rule instead of a handler per box. The press that focuses a box is
// the rule's: Chromium's own mousedown places the caret and anchors a drag selection, so a pointer that
// drifted a pixel before release left a partial highlight (owner, 2026-10-03; measured: 1px → nothing,
// 4px → "3" of "379"). That press's default is cancelled, the box focused and selected here, and its
// mouseup cancelled too (Chromium collapses a focus-time selection on it). A press inside a box that
// already has focus, or any other button, behaves as usual (caret, drag-select part of it).
const NOT_TEXT = new Set(['checkbox', 'radio', 'file', 'range', 'color', 'button', 'submit', 'reset', 'image', 'hidden',
  'date', 'time', 'datetime-local', 'month', 'week'])

export const selectable = (el) => !!el && !el.disabled
  && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !NOT_TEXT.has((el.type || 'text').toLowerCase())))

export function installSelectOnFocus(doc) {
  let pressed = null
  const down = (e) => {
    pressed = (e.button ?? 0) === 0 && selectable(e.target) && doc.activeElement !== e.target ? e.target : null
    if (!pressed) return
    e.preventDefault()                        // no caret, no drag anchor: nothing can shrink the selection
    pressed.focus?.()                         // focusin selects it
  }
  const focus = (e) => { if (selectable(e.target)) e.target.select() }
  const up = (e) => { if (pressed && e.target === pressed) e.preventDefault(); pressed = null }
  const on = [['mousedown', down], ['focusin', focus], ['mouseup', up]]
  for (const [t, f] of on) doc.addEventListener(t, f, true)
  return () => { for (const [t, f] of on) doc.removeEventListener(t, f, true) }
}
