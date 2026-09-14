// Demo subscriber — proves the hook bus works, with ZERO side effects.
//
// It attaches to an ExiledExchangeIntegration instance and console.logs each
// hook as it fires. Nothing here writes files, hits the network, or changes app
// state — it's the reference example for how a real subscriber (e.g. an actions
// layer) would consume the bus later. Note: we log the ACTION/shortcut label of a
// hotkey, never raw keystrokes (the watcher only ever reports configured combos).
'use strict'

const TAG = '[ee2]'

// Attaches listeners and returns a detach() to remove them cleanly on stop.
function attachLogDemo(integration) {
  const onDetected = (info) =>
    console.log(`${TAG} detected via ${info.method}${info.dir ? ` (${info.dir})` : ''}`)
  const onMissing = () =>
    console.log(`${TAG} not detected — integration dormant, will re-check periodically`)
  const onHotkey = (h) =>
    console.log(`${TAG} ee2-hotkey: ${h.action}${h.target ? ` -> ${h.target}` : ''} [${h.shortcut}]`)
  const onItem = (item) =>
    console.log(`${TAG} item-checked [${item.origin}]: ${item.rarity} "${item.name}"` +
      `${item.baseType ? ` / ${item.baseType}` : ''}` +
      `${item.itemClass ? ` (${item.itemClass})` : ''}` +
      `${item.corrupted ? ' [corrupted]' : ''}`)
  const onStarted = () => console.log(`${TAG} integration started`)
  const onStopped = () => console.log(`${TAG} integration stopped`)
  const onError = (err) => console.log(`${TAG} note: ${String(err && err.message || err)}`)

  integration.on('ee2-detected', onDetected)
  integration.on('ee2-missing', onMissing)
  integration.on('ee2-hotkey', onHotkey)
  integration.on('item-checked', onItem)
  integration.on('started', onStarted)
  integration.on('stopped', onStopped)
  integration.on('error', onError)

  return function detach() {
    integration.off('ee2-detected', onDetected)
    integration.off('ee2-missing', onMissing)
    integration.off('ee2-hotkey', onHotkey)
    integration.off('item-checked', onItem)
    integration.off('started', onStarted)
    integration.off('stopped', onStopped)
    integration.off('error', onError)
  }
}

module.exports = { attachLogDemo }
