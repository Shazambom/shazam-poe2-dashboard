// Every currency that bounds the mod pool (docs/mods-page-design.md → "Currencies that bound
// the pool"), read off the game's TieredCurrency and AbyssBenchTicketTypes tables via poe2db on
// 2026-09-25. `floor` is the orb's Minimum Modifier Level (0 = none); `cap` is the highest item
// level the currency can be used on (null = none). Hand-maintained until the tables are
// fetchable; a change here is a change in the game.
const orb = (group, tier, name, floor) => ({ id: `${tier}-${group}`, name, floor, cap: null, group })
const bone = (tier, part, floor, cap) => ({ id: `${tier}-${part}`.toLowerCase(), name: `${tier} ${part}`, floor, cap, group: 'bone' })

export const CURRENCIES = Object.freeze([
  orb('transmutation', 'greater', 'Greater Orb of Transmutation', 44),
  orb('transmutation', 'perfect', 'Perfect Orb of Transmutation', 70),
  orb('augmentation', 'greater', 'Greater Orb of Augmentation', 44),
  orb('augmentation', 'perfect', 'Perfect Orb of Augmentation', 70),
  orb('regal', 'greater', 'Greater Regal Orb', 35),
  orb('regal', 'perfect', 'Perfect Regal Orb', 50),
  orb('exalted', 'greater', 'Greater Exalted Orb', 35),
  orb('exalted', 'perfect', 'Perfect Exalted Orb', 50),
  orb('chaos', 'greater', 'Greater Chaos Orb', 35),
  orb('chaos', 'perfect', 'Perfect Chaos Orb', 50),
  bone('Gnawed', 'Jawbone', 0, 64), bone('Gnawed', 'Rib', 0, 64), bone('Gnawed', 'Collarbone', 0, 64),
  bone('Ancient', 'Jawbone', 40, null), bone('Ancient', 'Rib', 40, null), bone('Ancient', 'Collarbone', 40, null),
].map(Object.freeze))

export const FLOORS = Object.freeze([...new Set(CURRENCIES.map(c => c.floor).filter(Boolean))].sort((a, b) => a - b))

// The orb a typed floor reads back as: the first in orb order with that floor, none for 0 or a
// value no orb has.
export const currencyFor = (floor) => (floor ? CURRENCIES.find(c => c.floor === floor) || null : null)

export const floorOf = (id) => CURRENCIES.find(c => c.id === id)?.floor || 0
