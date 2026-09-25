// The orbs that carry a minimum modifier level (backend/app/modpool.py reads them off poe2db's
// currency list; the tab gets them with the pool list). The floor is the one stored value; the
// picker reads it back as the first orb with that floor, none for 0 or a value no orb has.
export const currencyFor = (currencies, floor) => (floor ? currencies.find(c => c.floor === floor) || null : null)
export const floorOf = (currencies, id) => currencies.find(c => c.id === id)?.floor || 0
// The picker's options: the orbs that set a floor, in the list's order.
export const orbOptions = (currencies) => currencies.filter(c => c.floor > 0)
