// Exiled-Exchange-2 (EE2) integration manager — a self-contained, PRESENCE-DRIVEN
// listening layer.
//
// Model (no settings toggle): on launch we detect EE2. If EE2 is PRESENT the
// integration runs, ALIGNED to EE2's own configured hotkeys; if EE2 is ABSENT it
// stays fully dormant and just re-checks on a light interval (so installing EE2
// later turns it on without an app restart). Presence is the only switch.
//
// How we listen (deterministic, aligned):
//   * hotkey-watcher (PRIMARY): a passive, non-consuming uiohook keyboard hook —
//     exactly how EE2 itself hooks keys — matching ONLY the combos EE2 has bound
//     (read from EE2's config.json). When EE2's price-check hotkey fires we kick a
//     short fast clipboard burst to capture the item inside EE2's ~120ms
//     clipboard-restore window, then emit item-checked{origin:'ee2'}.
//   * clipboard-watcher (FALLBACK): if uiohook can't run (native load failure, or
//     macOS Accessibility permission not granted so no events arrive) we silently
//     degrade to an adaptive clipboard poll. Also runs as a light safety net for
//     manual copies while uiohook is healthy.
//   * ee2-config: re-reads EE2's shortcuts and re-aligns us whenever the config
//     changes at runtime (a rebind in EE2 keeps us matched).
//
// Local only: uiohook + reading EE2's config + (peer) localhost are all fine; we
// make no remote calls. Strictly observational — no side effects on EE2.
//
// Events (the "hooks"):
//   'ee2-detected' {present, method, dir, config, running}   EE2 present
//   'ee2-missing'  {}                                        EE2 absent
//   'ee2-hotkey'   {action, target, shortcut, ts}            a configured EE2 combo fired
//   'item-checked' {name, baseType, rarity, itemClass, corrupted, unidentified,
//                   mirrored, origin:'ee2'|'clipboard', raw, ts}
//   'started' / 'stopped'   lifecycle
//   'error'        Error    non-fatal (e.g. clipboard-fallback note); never thrown
'use strict'

const { EventEmitter } = require('events')
const { ClipboardWatcher, captureItemBurst } = require('./clipboard-watcher')
const { HotkeyWatcher } = require('./hotkey-watcher')
const { readShortcuts, watchConfig } = require('./ee2-config')
const { detectEE2 } = require('./detect')

const REDETECT_MS = 30000   // re-check presence so a later EE2 install activates us
const SLOW_MS = 600         // clipboard safety-net cadence while uiohook is healthy
const FAST_MS = 90          // clipboard fallback cadence (uiohook unavailable/blocked)
const HEALTH_MS = 10000     // if uiohook delivers no key in this long, assume blocked
const HOTKEY_WINDOW_MS = 700 // an item captured within this long after an EE2 hotkey is attributed to EE2

class ExiledExchangeIntegration extends EventEmitter {
  constructor(opts = {}) {
    super()
    this._opts = opts
    this._started = false
    this._present = null       // last known EE2 presence (null = unknown)
    this._mode = 'idle'        // 'idle' | 'active'
    this._redetect = null
    // active-mode resources
    this._hotkey = null
    this._clip = null
    this._unwatchConfig = null
    this._healthTimer = null
    this._uiohookOk = false
    this._sawKey = false
    this._notifiedFallback = false
    this._lastEmit = null      // {hash, ts} — cross-source item dedupe
    this._hotkeyAt = 0         // ts of the last EE2 hotkey, for origin attribution
  }

  isRunning() { return this._started }
  isActive() { return this._mode === 'active' }

  async start() {
    if (this._started) return
    this._started = true
    await this._evaluatePresence(true)
    this._redetect = setInterval(() => { this._evaluatePresence(false) }, REDETECT_MS)
    if (this._redetect.unref) this._redetect.unref()
    this.emit('started', {})
  }

  stop() {
    if (!this._started) return
    if (this._redetect) { clearInterval(this._redetect); this._redetect = null }
    this._deactivate()
    this._started = false
    this._present = null
    this.emit('stopped', {})
  }

  // Detect EE2 and drive the presence state machine.
  async _evaluatePresence(initial) {
    let info
    try { info = await detectEE2({ checkProcess: true }) } catch { info = { present: false, method: 'none' } }
    const present = Boolean(info.present)

    if (initial || present !== this._present) {
      this._present = present
      this.emit(present ? 'ee2-detected' : 'ee2-missing', info)
    }
    if (present && this._mode !== 'active') this._activate()
    else if (!present && this._mode === 'active') this._deactivate()
  }

  // Spin up the observers, aligned to EE2's config.
  _activate() {
    if (this._mode === 'active') return
    this._mode = 'active'
    this._sawKey = false
    this._notifiedFallback = false

    // Clipboard safety net (also the fallback surface). Starts slow; we speed it
    // up if uiohook turns out unavailable or blocked.
    this._clip = new ClipboardWatcher({
      intervalMs: SLOW_MS,
      onItem: (item) => this._emitItem(item, 'clipboard'),
    })
    try { this._clip.start() } catch (e) { this._safeError(e) }

    // Passive hotkey hook (primary, deterministic).
    this._hotkey = new HotkeyWatcher({
      onFirstKey: () => { this._sawKey = true; this._relaxClipboard() },
      onHotkey: (h) => this._onHotkey(h),
    })
    this._uiohookOk = false
    try { this._uiohookOk = this._hotkey.start() } catch (e) { this._safeError(e) }

    if (this._uiohookOk) {
      this._applyShortcuts()
      try { this._unwatchConfig = watchConfig(() => this._applyShortcuts()) } catch (e) { this._safeError(e) }
      // macOS Accessibility guard: if no key event ever arrives, uiohook loaded
      // but the OS is withholding events — degrade to the clipboard fallback.
      this._healthTimer = setTimeout(() => {
        if (!this._sawKey) this._degradeToClipboard('uiohook loaded but received no key events (grant Accessibility permission on macOS to enable hotkey alignment)')
      }, HEALTH_MS)
      if (this._healthTimer.unref) this._healthTimer.unref()
    } else {
      // Native hook unavailable — clipboard-only from the start.
      this._degradeToClipboard('uiohook-napi unavailable — using clipboard fallback')
    }
  }

  _deactivate() {
    if (this._mode !== 'active') return
    if (this._healthTimer) { clearTimeout(this._healthTimer); this._healthTimer = null }
    try { this._unwatchConfig?.() } catch {}
    try { this._hotkey?.stop() } catch {}
    try { this._clip?.stop() } catch {}
    this._unwatchConfig = null
    this._hotkey = null
    this._clip = null
    this._uiohookOk = false
    this._sawKey = false
    this._mode = 'idle'
  }

  _applyShortcuts() {
    if (!this._hotkey) return
    try { this._hotkey.setShortcuts(readShortcuts()) } catch (e) { this._safeError(e) }
  }

  _onHotkey(h) {
    this.emit('ee2-hotkey', h)
    // An EE2 hotkey just fired — mark the moment and capture the item fast (beats
    // EE2's ~120ms clipboard restore). We fire on ANY EE2 hotkey rather than trying
    // to label which one is "price check" (EE2's binding often carries a generic
    // label): non-item hotkeys simply produce no new clipboard item, so the burst
    // is a harmless no-op, while the timestamp lets us attribute the capture to EE2.
    this._hotkeyAt = Date.now()
    try { captureItemBurst({ onItem: (item) => this._emitItem(item, 'ee2') }) } catch (e) { this._safeError(e) }
  }

  // uiohook is healthy (a key arrived) — no need to poll the clipboard fast.
  _relaxClipboard() {
    if (this._uiohookOk && this._clip) { try { this._clip.setIntervalMs(SLOW_MS) } catch {} }
  }

  // Speed the clipboard up to cover EE2's restore window when uiohook can't.
  _degradeToClipboard(message) {
    if (this._clip) { try { this._clip.setIntervalMs(FAST_MS) } catch {} }
    if (!this._notifiedFallback) { this._notifiedFallback = true; this._safeError(new Error(message)) }
  }

  // Single emit path with cross-source dedupe: the burst ('ee2') fires first and
  // wins; the slower safety-net poll won't re-emit the same item.
  _emitItem(item, origin) {
    const hash = `${item.raw.length}:${item.raw.slice(0, 64)}`
    const now = Date.now()
    if (this._lastEmit && this._lastEmit.hash === hash && now - this._lastEmit.ts < 1500) return
    this._lastEmit = { hash, ts: now }
    // Attribute to EE2 if the burst produced it OR an EE2 hotkey fired just before
    // this capture — so whichever watcher (burst or safety-net poll) grabbed the
    // item, a keypress-correlated check is labeled origin:'ee2', not 'clipboard'.
    const fromEe2 = origin === 'ee2' || (this._hotkeyAt && now - this._hotkeyAt < HOTKEY_WINDOW_MS)
    item.origin = fromEe2 ? 'ee2' : 'clipboard'
    try { this.emit('item-checked', item) } catch (e) { this._safeError(e) }
  }

  _safeError(err) {
    if (this.listenerCount('error') > 0) this.emit('error', err)
  }
}

module.exports = { ExiledExchangeIntegration }
