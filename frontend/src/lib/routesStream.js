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

// One route search, start to finish. Every event goes to `h` (meta / routes / scores / done / fail), and the
// stream closes on done or failure. A search that goes silent for SEARCH_IDLE_MS is closed and reported to
// `h.timeout` (else as a failure), so the page never sits "searching" on a dead stream (2026-10-05: the list stayed
// blank behind one).
// Returns close(): a superseded search is closed by the page and reports nothing more.
export const SEARCH_IDLE_MS = 30000

export function streamSearch(url, h, deps = globalThis) {
  const es = new deps.EventSource(url)
  let timer = null
  let over = false
  const stop = () => { over = true; deps.clearTimeout(timer); es.close() }
  const arm = () => { deps.clearTimeout(timer); timer = deps.setTimeout(() => { if (!over) { stop(); (h.timeout || h.fail)(null) } }, SEARCH_IDLE_MS) }
  const on = (type, fn) => es.addEventListener(type, (e) => { if (over) return; arm(); fn(e) })
  on('meta', e => h.meta(JSON.parse(e.data)))
  on('routes', e => h.routes(JSON.parse(e.data)))
  on('scores', e => h.scores(JSON.parse(e.data)))
  on('progress', () => {})                     // the server is still searching: only re-arms the watchdog
  on('done', e => { stop(); h.done(JSON.parse(e.data)) })
  on('error', e => {
    let msg = null
    if (e.data) { try { msg = JSON.parse(e.data).error } catch { msg = 'stream error' } }
    stop(); h.fail(msg)
  })
  arm()
  return stop
}
