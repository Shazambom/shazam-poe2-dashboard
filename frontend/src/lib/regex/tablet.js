// The Precursor Tablet search string: rarity, tablet kind, uses remaining, mods, price, appended
// text. The kinds (Irradiated, Ritual, ...) come from the table: each carries the description
// line every tablet of that kind prints ("Adds a Mirror of Delirium to a Map") and the token the
// sync script computed for it with the same uniqueness rule as the mods.
import { rangeRegex, priceRange } from './number.js'
import { rarity, wantedTerms, joinTerms } from './terms.js'

// "10 uses remaining" / "1 use remaining" is on every tablet and no waystone; the kind anchor
// when no uses term is.
const ANCHOR = '" rem"'

export function tabletRegex(s, table) {
  const uses = usesTerm(s.uses)
  return joinTerms([
    rarity(s.rarity),
    kindTerm(s.type, table.kinds || []),
    uses,
    ...wantedTerms(s.want, s.wantMode, table, s.round10),
    s.price?.on ? priceRange(s.price.min, s.price.max, s.price.currency) : null,
    s.append || null,
  ], ANCHOR, !!uses)
}

function kindTerm(type, kinds) {
  const on = kinds.filter(k => type[k.key]).map(k => k.regex)
  if (!on.length || on.length === kinds.length) return null
  return `"(${on.join('|')})"`
}

// "9 uses remaining" / "1 use remaining": at least n, n in 1..18.
function usesTerm(n) {
  n = Number(n) || 0
  if (n < 1 || n > 18) return null
  return `"${rangeRegex(n, 18)} us"`
}
