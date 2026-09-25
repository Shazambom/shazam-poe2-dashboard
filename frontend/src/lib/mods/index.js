// What is open, per pool, for the session (a hop to Workspace and back finds it open; a restart
// does not, it is not user data). Read into state on pool change, written back on every toggle.
const session = new Map()
export const sessionFor = (poolId) => {
  if (!session.has(poolId)) session.set(poolId, { rows: new Set(), sections: new Set() })
  return session.get(poolId)
}
