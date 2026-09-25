// The Mods tab's data: the shipped tables, loaded once on first use and kept for the session so
// the main chunk never carries them. Zero network: every file is bundled.
let loading = null

export function loadMods() {
  if (!loading) {
    loading = Promise.all([
      import('../../data/mods/pools.json'), import('../../data/mods/mods.json'),
      import('../../data/mods/essences.json'), import('../../data/mods/augments.json'),
    ])
      .then(([p, m, e, a]) => ({ pools: p.default.pools, families: m.default.families, essences: e.default.essences, augments: a.default.augments }))
      .catch(e => { loading = null; throw e })
  }
  return loading
}

// Which families and which sections are open, per pool, for the session: a hop to Workspace
// and back finds them open, a restart does not (they are not user data).
const expanded = new Map()
export const expandedFor = (poolId) => { if (!expanded.has(poolId)) expanded.set(poolId, new Set()); return expanded.get(poolId) }
const sections = new Map()
export const openSectionsFor = (poolId) => { if (!sections.has(poolId)) sections.set(poolId, new Set()); return sections.get(poolId) }
