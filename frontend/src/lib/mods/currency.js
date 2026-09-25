// Every currency that bounds the mod pool from below (docs/mods-page-design.md → "Currencies
// that bound the pool"), read off the game's TieredCurrency and AbyssBenchTicketTypes tables via
// poe2db on 2026-09-25. `floor` is the orb's Minimum Modifier Level. Hand-maintained until the
// tables are fetchable; a change here is a change in the game.
const orb = (id, name, floor) => ({ id, name, floor })

export const CURRENCIES = Object.freeze([
  orb('greater-transmutation', 'Greater Orb of Transmutation', 44),
  orb('perfect-transmutation', 'Perfect Orb of Transmutation', 70),
  orb('greater-augmentation', 'Greater Orb of Augmentation', 44),
  orb('perfect-augmentation', 'Perfect Orb of Augmentation', 70),
  orb('greater-regal', 'Greater Regal Orb', 35),
  orb('perfect-regal', 'Perfect Regal Orb', 50),
  orb('greater-exalted', 'Greater Exalted Orb', 35),
  orb('perfect-exalted', 'Perfect Exalted Orb', 50),
  orb('greater-chaos', 'Greater Chaos Orb', 35),
  orb('perfect-chaos', 'Perfect Chaos Orb', 50),
  orb('ancient-jawbone', 'Ancient Jawbone', 40),
  orb('ancient-rib', 'Ancient Rib', 40),
  orb('ancient-collarbone', 'Ancient Collarbone', 40),
].map(Object.freeze))

// The orb a typed floor reads back as: the first in orb order with that floor, none for 0 or a
// value no orb has.
export const currencyFor = (floor) => (floor ? CURRENCIES.find(c => c.floor === floor) || null : null)

export const floorOf = (id) => CURRENCIES.find(c => c.id === id)?.floor || 0
