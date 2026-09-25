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

// What is open, per pool, for the session (a hop to Workspace and back finds it open; a restart
// does not, it is not user data). Read into state on pool change, written back on every toggle.
const session = new Map()
export const sessionFor = (poolId) => {
  if (!session.has(poolId)) session.set(poolId, { rows: new Set(), sections: new Set() })
  return session.get(poolId)
}
