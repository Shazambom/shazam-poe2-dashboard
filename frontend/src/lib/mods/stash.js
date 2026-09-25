// Trading → Mods → "Find in stash" (docs/mods-page-design.md): a waystone or tablet family as
// a wanted modifier of the Regex tab, whose table lists a modifier per printed line (forms
// joined by " ~ ", lines by " | "). A pool family is the game's mod, often several lines: it
// wants every table modifier one of its lines prints. Pure; the view saves and switches tabs.
import { formsOf, linesOf } from '../regex/shortest.js'

const KIND_OF_CLASS = { Waystones: 'waystone', Tablet: 'tablet' }

// The Regex tab's kind for a pool, or null when the tab has no table for it.
export const stashKind = (pool) => (pool && KIND_OF_CLASS[pool.class]) || null

// The ids of the table modifiers any line of the family prints, in table order, once each.
export function stashMods(family, table) {
  const lines = new Set((family?.text || '').split('\n'))
  return (table?.mods || []).filter(m => formsOf(m.text).some(f => linesOf(f).some(l => lines.has(l)))).map(m => m.id)
}

// The Regex tab's settings (already merged over its defaults) with the kind selected and the
// ids wanted: one already wanted keeps its minimum, a new one has none.
export function withWanted(settings, kind, ids) {
  const have = new Set(settings[kind].want.map(w => w.id))
  const want = [...settings[kind].want, ...ids.filter(id => !have.has(id)).map(id => ({ id, min: 0 }))]
  return { ...settings, kind, [kind]: { ...settings[kind], want } }
}
