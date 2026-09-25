// The pools that are lists rather than rolls: what an essence forces on a class, and what a
// rune, soul core or idol grants where it fits. Pure; the tables are frontend/src/data/mods/
// essences.json and augments.json.

// The essences that touch this pool's class, each with only that class's row, Lesser to Perfect.
export function essencesFor(def, essences) {
  return essences
    .map(e => ({ ...e, rows: e.rows.filter(r => r.class === def.class) }))
    .filter(e => e.rows.length)
    .sort((a, b) => a.tier - b.tier || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

const TYPE_ORDER = ['Rune', 'Soul Core', 'Idol']

// The socketables that fit this pool's class, runes first, each with one fit: what it grants there
// (a general text and a class-specific bonded effect are two entries in the table, one here).
export function augmentsFor(def, augments) {
  return augments
    .map(a => {
      const fits = a.fits.filter(f => f.classes.includes(def.class))
      return { ...a, fits: fits.length ? [{ classes: [def.class], text: [...new Set(fits.flatMap(f => f.text))], bonded: [...new Set(fits.flatMap(f => f.bonded))] }] : [] }
    })
    .filter(a => a.fits.length)
    .sort((a, b) => {
      const ta = TYPE_ORDER.indexOf(a.type), tb = TYPE_ORDER.indexOf(b.type)
      return (ta === -1 ? 9 : ta) - (tb === -1 ? 9 : tb) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    })
}
