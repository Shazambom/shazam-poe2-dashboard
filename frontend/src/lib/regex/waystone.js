// The Waystone search string: rarity, tier, revives, mods, state, yields, price, appended text.
import { minRegex, rangeRegex, priceRange } from './number.js'
import { rarity, wantedTerms, avoidTerm, joinTerms } from './terms.js'

// "Waystone (Tier 14)" is the base-name line every waystone prints; the kind anchor keeps
// tablets out of a mixed stash tab when no tier term is there to do it.
const ANCHOR = '"e \\(T"'

export function waystoneRegex(s, table) {
  const tier = tierTerm(s.tier)
  return joinTerms([
    rarity(s.rarity),
    tier,
    revivesTerm(s.revives),
    ...wantedTerms(s.want, s.wantMode, table, s.round10),
    avoidTerm(s.avoid, table),
    stateTerm(s.state),
    ...yieldTerms(s),
    s.price?.on ? priceRange(s.price.min, s.price.max, s.price.currency) : null,
    s.append || null,
  ], ANCHOR, !!tier)
}

// The term anchors on the closing paren: "r 1[4-6]\)" for 14 to 16, "r ([3-9]|1[0-2])\)" for
// 3 to 12.
function tierTerm({ min, max }) {
  if (!(min >= 1 && max >= min && max <= 16)) return null
  if (min <= 1 && max >= 16) return null
  return `"r ${rangeRegex(min, max)}\\)"`
}

// "Revives Available: 3".
function revivesTerm({ min, max }) {
  if (!(min >= 0 && max >= min && max <= 6)) return null
  if (min <= 0 && max >= 6) return null
  return `"le: ${rangeRegex(min, max)}"`
}

function stateTerm({ corrupted, uncorrupted, delirious }) {
  const corr = corrupted && !uncorrupted ? 'corr' : !corrupted && uncorrupted ? '!corr' : null
  return [delirious ? 'delir' : null, corr].filter(Boolean).join(' ') || null
}

// The five yield lines: "Item Rarity: +30%", "Waystone Drop Chance", "Monster Effectiveness",
// "Monster Rarity", "Pack Size". A 0, or a threshold Round to tens takes to 0, is "any".
function yieldTerms(s) {
  const one = (prefix, value) => { const n = minRegex(String(value || 0), s.round10); return n ? `"${prefix}${n}%"` : null }
  return [
    one('m rar.*', s.itemRarity),
    one('p c.*', s.dropChance),
    one('r ef.*', s.monsterEffect),
    one('r rar.*', s.monsterRarity),
    one('k s.*', s.packSize),
  ]
}
