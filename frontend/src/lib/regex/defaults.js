// The Regex tab's settings shape, one object per kind, and the one number the tab is measured
// against. Persisted under `regex_tools` in the settings blob (user.sqlite); `merge` folds a
// stored partial over these so a new key never reads as undefined.

export const LIMIT = 250   // the in-game search box

export const KINDS = ['waystone', 'tablet']

const price = () => ({ on: false, trade: false, min: 0, max: 999, currency: 'exalted' })
const rarity = () => ({ normal: false, magic: false, rare: false })

export const defaults = Object.freeze({
  waystone: Object.freeze({
    rarity: rarity(),
    tier: { min: 1, max: 16 },
    revives: { min: 0, max: 6 },
    state: { corrupted: false, uncorrupted: false, delirious: false },
    itemRarity: 0, dropChance: 0, monsterEffect: 0, monsterRarity: 0, packSize: 0,   // 0 = any
    round10: false,
    wantMode: 'any',           // 'any' | 'all'
    want: [],                  // [{ id, min }]  min 0 = no number
    avoid: [],                 // [id]
    price: price(),
    append: '',
  }),
  tablet: Object.freeze({
    rarity: rarity(),
    // one key per kind in the tablet table (frontend/src/data/regex/tablet-kinds.json)
    type: { irradiated: false, ritual: false, delirium: false, breach: false, abyss: false, temple: false, overseer: false, expedition: false },
    uses: 0,                   // 0 = any, else the minimum uses remaining (1..18)
    round10: false,
    wantMode: 'any',
    want: [],
    price: price(),
    append: '',
  }),
})

export const defaultOptions = Object.freeze({ kind: 'waystone', autoCopy: false })

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

// Every key of `base`, taken from `over` when it has it (objects recurse, arrays and scalars
// replace), always as a fresh copy so nothing the caller edits can reach the defaults.
function deepMerge(base, over) {
  const o = isObj(over) ? over : {}
  const out = {}
  for (const [k, b] of Object.entries(base)) out[k] = isObj(b) ? deepMerge(b, o[k]) : structuredClone(k in o ? o[k] : b)
  return out
}

// A stored blob (any subset, any age) folded over the defaults; an unknown kind reads as the first.
export function merge(stored) {
  const m = deepMerge({ ...defaultOptions, ...defaults }, stored)
  if (!KINDS.includes(m.kind)) m.kind = KINDS[0]
  return m
}

export const overLimit = (text) => text.length > LIMIT
