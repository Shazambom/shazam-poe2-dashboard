// Runs a ⌘K screen action the way a user would: the control it names carries `data-cmd="<target>"` in its screen,
// and once that screen has drawn it the action focuses it (an input inside a marked wrapper gets the focus) or
// clicks it. Gives up after `maxFrames` frames rather than waiting forever (the screen failed to load).
export function runTarget(target, act, { doc = globalThis.document, raf = globalThis.requestAnimationFrame, maxFrames = 120 } = {}) {
  return new Promise(resolve => {
    let n = 0
    const tick = () => {
      const el = doc?.querySelector(`[data-cmd="${target}"]`)
      if (el) {
        if (act === 'click') el.click()
        else (el.querySelector?.('input, select, textarea, button') || el).focus()
        return resolve(true)
      }
      if (++n >= maxFrames) return resolve(false)
      raf(tick)
    }
    tick()
  })
}

// The current screen's actions a user could take right now: an action that works a control is listed only while
// that control is drawn and enabled (Start timer is gone while Override is on; Copy regex while there is no regex).
// Actions App runs itself are always kept.
export const usableHere = (cmds, doc = globalThis.document) => cmds.filter(c => {
  if (!c.target) return true
  const el = doc?.querySelector(`[data-cmd="${c.target}"]`)
  return !!el && !el.disabled
})
