// What is open, per pool, for the session (a hop to Workspace and back finds it open; a restart
// does not, it is not user data). Read into state on pool change, written back on every toggle.
const session = new Map()
export const sessionFor = poolId => session.get(poolId)
export const rememberOpen = (poolId, kind, ids) => {
  session.set(poolId, { ...session.get(poolId), [kind]: ids })
}

// The pasted item (Trading → Mods → Paste item), for the session: a hop to Workspace or Regex
// and back finds it; a restart does not. One item at a time, whatever the pool.
let pastedItem = null
export const pasted = { get: () => pastedItem, set: (item) => { pastedItem = item || null } }
