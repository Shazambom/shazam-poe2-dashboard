// Which way a dropdown opens (components/CurrencyPicker.jsx). Pure.
// Below when the list fits there; otherwise toward whichever side has more room, so a picker at the
// bottom of a scrolling page opens upward instead of being cut off.
export const opensUp = ({ below, above, need }) => below < need && above > below

// The room around `box` inside the nearest scrolling ancestor (or the window): what can clip a list.
export function room(box) {
  const r = box.getBoundingClientRect()
  let top = 0, bottom = window.innerHeight
  for (let e = box.parentElement; e; e = e.parentElement) {
    const o = getComputedStyle(e).overflowY
    if (o === 'auto' || o === 'scroll' || o === 'hidden') {
      const pr = e.getBoundingClientRect()
      top = Math.max(top, pr.top)
      bottom = Math.min(bottom, pr.bottom)
      break
    }
  }
  return { below: bottom - r.bottom, above: r.top - top }
}
