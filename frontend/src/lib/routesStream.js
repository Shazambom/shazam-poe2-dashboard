// What the routes page keeps when a search stream finishes. A fresh search streams every loop
// that passed the filters as it is found (so the table fills while the search runs), then `done`
// carries the authoritative top list (`order`) and its scores; a cached replay streams only that
// list. The page must end up with the same loops either way, or the σ-banding above it runs on
// two different populations and the same search shows 82 rows once and 20 rows two minutes later
// (owner, 2026-09-23). Older servers send no `order`: keep what streamed, scores applied.
export function finishRoutes(streamed, done) {
  const scores = done?.scores || {}
  const byId = new Map(streamed.map(r => [r.id, r]))
  const pick = Array.isArray(done?.order) ? done.order.map(id => byId.get(id)).filter(Boolean) : [...streamed]
  return pick.map(r => (scores[r.id] != null ? { ...r, score: scores[r.id] } : r))
}
