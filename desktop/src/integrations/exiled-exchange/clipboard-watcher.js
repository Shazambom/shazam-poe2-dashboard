// Clipboard watcher — the primary, dependency-free cross-app signal for "an item
// was checked".
//
// Why the clipboard: Exiled-Exchange-2 (EE2, like Awakened PoE Trade) has NO
// public hook/plugin API. Its real server is a localhost websocket on an
// EPHEMERAL port (bound to `0` in production, port never written to disk — see
// main/src/server.ts + main/src/main.ts, which hand the port to the renderer
// in-process via overlay.loadAppPage). The one thing every price check depends on
// is the game copying the hovered item's text to the OS clipboard (Ctrl+C/Ctrl+D
// over an in-game item). We observe that passively, without touching EE2.
//
// IMPORTANT timing note: EE2's own hotkey flow CLEARS the clipboard, reads the
// item, then RESTORES the previous contents after ~120ms (RESTORE_AFTER in EE2
// main/src/shortcuts/HostClipboard.ts). So during an EE2 price check the item
// text only lives ~120ms. A 600ms poll reliably catches MANUAL Ctrl+C copies but
// would miss EE2's transient hotkey flow. Hence this watcher supports an ADAPTIVE
// interval: the manager drops us to ~90ms when EE2 is detected running, so we can
// catch that ~120ms window; we stay at 600ms otherwise to stay cheap.
//
// We only READ the clipboard (never clear/rewrite) so we can't interfere with
// EE2's own read/restore dance.
'use strict'

// Lazy electron require so this file's pure parser can be unit-tested (and
// self-tested via `node clipboard-watcher.js`) without an Electron runtime.
let _clipboard = null
function clip() {
  if (!_clipboard) _clipboard = require('electron').clipboard
  return _clipboard
}

// Leading markers that identify copied PoE/PoE2 item text, for a cheap presence
// check. Modern PoE2 items lead with "Item Class:"; some simple copies lead
// straight at "Rarity:". A few localized leads are included so non-English
// clients still register. (Presence only — field parsing is handled below.)
const ITEM_MARKERS = [
  'Item Class:', 'Rarity:',      // en
  'アイテムクラス:', 'レアリティ:',  // ja
  '物品类别:', '稀有度:',          // zh
  '아이템 종류:',                  // ko
  'Тип предмета:',               // ru
]

// Localized labels for the two header fields we extract. Matching is by label
// regex; if a client's labels aren't in this list we still recover the fields
// POSITIONALLY (PoE always orders the header Item Class -> Rarity), so parsing
// degrades gracefully rather than half-working. This keeps localized handling
// CONSISTENT instead of special-casing only a couple of languages.
const CLASS_LABEL = /^(item class|アイテムクラス|物品类别|아이템 종류|тип предмета)$/i
const RARITY_LABEL = /^(rarity|レアリティ|稀有度|아이템 희귀도|редкость)$/i

const isSeparator = (line) => /^-{3,}$/.test(line.trim())

function looksLikeItem(text) {
  if (!text || text.length < 12) return false
  const head = text.trimStart()
  return ITEM_MARKERS.some((m) => head.startsWith(m))
}

// Original parser for PoE2 clipboard item text (written from the format, not
// copied from EE2/APT). The header block — everything before the first
// "--------" — looks like:
//
//   Item Class: Two Hand Swords   <- itemClass  (present on modern PoE2 items)
//   Rarity: Rare                  <- rarity     (always present)
//   Foe Slicer                    <- name
//   Bastard Sword                 <- baseType   (absent for currency/omen/gems)
//   --------                      (header ends here; mods follow)
//
// A header line with "Label: value" shape is a FIELD; label-less lines are the
// name then base type. We label fields by localized regex, then fall back to
// position (1st field = class, 2nd = rarity) so non-English clients still parse.
function parseItem(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')

  let itemClass = ''
  let rarity = ''
  const fieldsInOrder = []   // [{label, value}] for positional fallback
  const nameLines = []

  for (const line of lines) {
    if (isSeparator(line)) break            // header ends at the first divider
    const t = line.trim()
    if (!t) continue
    const m = t.match(/^([^:]{1,32}):\s*(.+)$/)
    if (m) {
      const label = m[1].trim()
      const value = m[2].trim()
      fieldsInOrder.push({ label, value })
      if (CLASS_LABEL.test(label)) itemClass = value
      else if (RARITY_LABEL.test(label)) rarity = value
    } else {
      nameLines.push(t)                     // name, then (maybe) base type
    }
  }

  // Positional fallback for unrecognized localized labels: fields always come in
  // the order Item Class -> Rarity, so fill whichever we didn't match by label.
  if (!itemClass && fieldsInOrder[0]) itemClass = fieldsInOrder[0].value
  if (!rarity && fieldsInOrder[1]) rarity = fieldsInOrder[1].value
  else if (!rarity && fieldsInOrder.length === 1) rarity = fieldsInOrder[0].value

  // Flags are standalone lines. English-canonical (localized flag words vary and
  // aren't needed for identity); raw is always available for deeper parsing.
  const flag = (word) => new RegExp(`^${word}$`, 'im').test(raw)

  return {
    name: nameLines[0] || '',
    baseType: nameLines[1] || '',
    rarity: rarity || 'Unknown',
    itemClass: itemClass || '',
    corrupted: flag('Corrupted'),
    unidentified: flag('Unidentified'),
    mirrored: flag('Mirrored'),
    raw,
    ts: Date.now(),
  }
}

// Watches the clipboard on an interval and calls onItem(parsedItem) once per
// distinct item. Dedupes consecutive identical clipboard contents. The interval
// is adaptive: setIntervalMs() lets the manager speed us up when EE2 is active.
class ClipboardWatcher {
  constructor({ intervalMs = 600, onItem } = {}) {
    this._intervalMs = this._clamp(intervalMs)
    this._onItem = typeof onItem === 'function' ? onItem : () => {}
    this._timer = null
    this._lastHash = null
  }

  _clamp(ms) { return Math.min(Math.max(ms | 0, 60), 2000) }

  start() {
    if (this._timer) return
    // Seed with current clipboard so an item copied BEFORE we started doesn't
    // fire a phantom event on the first tick.
    try { this._lastHash = this._hash(clip().readText()) } catch {}
    this._arm()
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
    this._lastHash = null
  }

  // Change cadence at runtime (adaptive polling). No-ops if unchanged; preserves
  // the dedupe hash so switching speed never re-fires the current clipboard.
  setIntervalMs(ms) {
    const next = this._clamp(ms)
    if (next === this._intervalMs) return
    this._intervalMs = next
    if (this._timer) { clearInterval(this._timer); this._arm() }
  }

  getIntervalMs() { return this._intervalMs }

  _arm() {
    this._timer = setInterval(() => this._tick(), this._intervalMs)
    if (this._timer.unref) this._timer.unref()   // never hold the app open
  }

  _hash(text) { return `${text.length}:${text.slice(0, 64)}` }

  _tick() {
    let text = ''
    try { text = clip().readText() } catch { return }
    if (!text) return
    const h = this._hash(text)
    if (h === this._lastHash) return          // dedupe repeats
    this._lastHash = h
    if (!looksLikeItem(text)) return          // ignore non-item clipboard writes
    let item
    try { item = parseItem(text) } catch { return }
    if (!item.name) return
    try { this._onItem(item) } catch {}
  }
}

// A short FAST clipboard burst, kicked the instant an EE2 price-check hotkey
// fires. EE2 clears -> reads -> restores the clipboard within ~120ms, so we read
// every ~15ms for ~250ms to reliably catch the item text inside that window,
// then stop on the first NEW item. This is the deterministic capture path
// (aligned to the actual keypress) — far more reliable than idle polling.
//
// baseline = the clipboard hash at kickoff; we ignore it so a previously-copied
// item doesn't get re-emitted when the current hover yields nothing.
function captureItemBurst({ intervalMs = 15, durationMs = 250, onItem } = {}) {
  const cb = typeof onItem === 'function' ? onItem : () => {}
  let baseline = null
  try { baseline = `${clip().readText().length}` } catch {}
  const startText = (() => { try { return clip().readText() } catch { return '' } })()
  const baseHash = `${startText.length}:${startText.slice(0, 64)}`
  let elapsed = 0
  const timer = setInterval(() => {
    let text = ''
    try { text = clip().readText() } catch {}
    const h = `${text.length}:${text.slice(0, 64)}`
    if (text && h !== baseHash && looksLikeItem(text)) {
      let item
      try { item = parseItem(text) } catch {}
      if (item && item.name) { clearInterval(timer); try { cb(item) } catch {}; return }
    }
    elapsed += intervalMs
    if (elapsed >= durationMs) clearInterval(timer)
  }, intervalMs)
  if (timer.unref) timer.unref()
  return () => clearInterval(timer)
}

module.exports = { ClipboardWatcher, parseItem, looksLikeItem, captureItemBurst }

// --- tiny self-test: `node clipboard-watcher.js` (pure parser, no Electron) ---
// Guards against parser regressions for the common PoE2 item shapes.
if (require.main === module) {
  const strip = (o) => { const { raw, ts, ...rest } = o; return rest }
  const eq = (a, b, msg) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      console.error('FAIL', msg, '\n  got   ', JSON.stringify(a), '\n  expect', JSON.stringify(b))
      process.exitCode = 1
    } else { console.log('ok  ', msg) }
  }

  const gear = `Item Class: Two Hand Swords\nRarity: Rare\nFoe Slicer\nBastard Sword\n--------\nPhysical Damage: 50-90\n--------\nCorrupted`
  eq(strip(parseItem(gear)),
     { name: 'Foe Slicer', baseType: 'Bastard Sword', rarity: 'Rare', itemClass: 'Two Hand Swords', corrupted: true, unidentified: false, mirrored: false },
     'rare gear + corrupted')

  const currency = `Item Class: Stackable Currency\nRarity: Currency\nExalted Orb\n--------\nStack Size: 12/20`
  eq(strip(parseItem(currency)),
     { name: 'Exalted Orb', baseType: '', rarity: 'Currency', itemClass: 'Stackable Currency', corrupted: false, unidentified: false, mirrored: false },
     'currency (single-line name, no base type)')

  const omen = `Item Class: Omen\nRarity: Currency\nOmen of Amelioration\n--------\nStack Size: 1/10`
  eq(strip(parseItem(omen)),
     { name: 'Omen of Amelioration', baseType: '', rarity: 'Currency', itemClass: 'Omen', corrupted: false, unidentified: false, mirrored: false },
     'omen')

  const unid = `Item Class: Body Armours\nRarity: Rare\nUnknown Item\nSimple Robe\n--------\nUnidentified`
  eq(strip(parseItem(unid)).unidentified, true, 'unidentified flag')

  // Localized (Japanese) via positional fallback — labels unmatched, order holds.
  const ja = `アイテムクラス: 兜\nレアリティ: レア\n名前\n--------`
  const jaOut = strip(parseItem(ja))
  eq({ itemClass: jaOut.itemClass, rarity: jaOut.rarity, name: jaOut.name },
     { itemClass: '兜', rarity: 'レア', name: '名前' }, 'localized header (positional)')

  eq(looksLikeItem(gear), true, 'looksLikeItem: item')
  eq(looksLikeItem('just some random clipboard text here'), false, 'looksLikeItem: junk')

  console.log(process.exitCode ? '\nSELF-TEST FAILED' : '\nself-test passed')
}
