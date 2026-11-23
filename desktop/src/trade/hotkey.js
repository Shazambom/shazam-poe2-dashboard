// Global focus hotkey (default Ctrl/Cmd+G). System-wide: raises Arbiter from the
// background straight onto Trading → Live and focuses the newest ping's button, so the
// user can act the instant they hear the ping. Re-bindable; fails gracefully if the combo
// is already taken by another app.
'use strict'
const { ignored } = require('../ignored.js')
const { globalShortcut } = require('electron')

let current = null

function fire(getWin) {
  const w = getWin && getWin()
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  try { w.webContents.send('hotkey:focus-live') } catch (e) { ignored('hotkey:send-focus', e) }
}

const register = (getWin, combo) => { try { return globalShortcut.register(combo, () => fire(getWin)) } catch { return false } }

// Returns { ok, combo }. ok=false means the OS refused the combo (already in use); the previous combo,
// which Settings keeps showing and main keeps saved, is registered again so the hotkey keeps working.
function registerHotkey(getWin, combo) {
  const previous = current
  if (current) { try { globalShortcut.unregister(current) } catch (e) { ignored('hotkey:unregister', e) } current = null }
  if (!combo) return { ok: false, combo }
  const ok = register(getWin, combo)
  if (ok) current = combo
  else if (previous && register(getWin, previous)) current = previous
  return { ok, combo }
}

function unregisterAll() { try { globalShortcut.unregisterAll() } catch (e) { ignored('hotkey:unregister-all', e) } current = null }
module.exports = { registerHotkey, unregisterAll }
