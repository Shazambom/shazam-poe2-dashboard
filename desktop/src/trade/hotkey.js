// Global focus hotkey (default Ctrl/Cmd+G). System-wide: raises Arbiter from the
// background straight onto Trading → Live and focuses the newest ping's button, so the
// user can act the instant they hear the ping. Re-bindable; fails gracefully if the combo
// is already taken by another app.
const { globalShortcut } = require('electron')

let current = null

function fire(getWin) {
  const w = getWin && getWin()
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  try { w.webContents.send('hotkey:focus-live') } catch {}
}

// Returns { ok, combo }. ok=false means the OS refused the combo (already in use).
function registerHotkey(getWin, combo) {
  if (current) { try { globalShortcut.unregister(current) } catch {} current = null }
  if (!combo) return { ok: false, combo }
  let ok = false
  try { ok = globalShortcut.register(combo, () => fire(getWin)) } catch { ok = false }
  if (ok) current = combo
  return { ok, combo }
}

function unregisterAll() { try { globalShortcut.unregisterAll() } catch {} current = null }
module.exports = { registerHotkey, unregisterAll }
