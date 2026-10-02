// Client for the backend-owned pathofexile.com rate budget.
//
// Electron (live-search fetch + whisper) and the bundled backend (exchange sweeps) hit the same
// account/IP limits, so ONE process must own the budget: the backend's gateway.Policy does. Before
// each trade request the engine reserves a slot here (a loopback POST that answers in ~1ms, ahead
// of a request to pathofexile.com that takes hundreds), and afterwards reports the response's
// X-Rate-Limit headers so the backend's view stays exact. If the local backend is unreachable we
// fail OPEN (same as having no budget) — the app never blocks the user on its own diagnostics.
'use strict'

class RateLimitError extends Error {
  constructor(retryAfter) { super(`rate-limited, retry in ${retryAfter}s`); this.retryAfter = retryAfter; this.code = 'RATE_LIMITED' }
}

let _backendUrl = () => 'http://127.0.0.1:8210'
function configure({ backendUrl }) { if (backendUrl) _backendUrl = backendUrl }

async function acquire(policy) {
  let r
  try {
    const resp = await fetch(`${_backendUrl()}/api/ratelimits/acquire`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy }),
      signal: AbortSignal.timeout(3000),
    })
    r = await resp.json()
  } catch { return }                       // backend down → fail open
  if (r && r.ok === false) throw new RateLimitError(Math.max(1, Math.ceil(r.retry_after_s || 1)))
}

// Only the rate-limit family + Retry-After are reported (never cookies or bodies).
function observe(policy, status, headers) {
  const h = {}
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase()
    if (key.startsWith('x-rate-limit') || key === 'retry-after') h[key] = Array.isArray(v) ? v[0] : String(v)
  }
  try {
    fetch(`${_backendUrl()}/api/ratelimits/observe`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy, status, headers: h }), signal: AbortSignal.timeout(3000),
    }).catch(() => {})
  } catch {}
}

// Tell the backend a request it didn't make just spent a slot (an EE2 price check on the same
// account/IP — batch 4-B). Fire-and-forget; the backend folds it in without penalising.
function hint(policy) {
  try {
    fetch(`${_backendUrl()}/api/ratelimits/hint`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy }), signal: AbortSignal.timeout(3000),
    }).catch(() => {})
  } catch {}
}

// One trade-site request under the shared budget: reserve a slot, send, report the headers, classify.
// Every caller (Sales, the unique pricer) reads the same answer: { ok: true, status, data } or
// { ok: false, error: 'rate' | 'auth' | 'HTTP n' | message, status?, retryAfter? }.
// deps: { request(req) → { status, headers, body }, budget: { acquire, observe } } (injectable for tests).
async function budgeted({ request, budget }, policy, req) {
  try { await budget.acquire(policy) } catch (e) { return { ok: false, error: 'rate', retryAfter: e.retryAfter } }
  let resp
  try { resp = await request(req) } catch (e) { return { ok: false, error: String(e && e.message || e) } }
  budget.observe(policy, resp.status, resp.headers)
  if (resp.status === 429) return { ok: false, error: 'rate', status: 429, retryAfter: Number(resp.headers?.['retry-after'] || 60) }
  if (resp.status === 401 || resp.status === 403) return { ok: false, error: 'auth', status: resp.status }
  if (resp.status !== 200) return { ok: false, error: `HTTP ${resp.status}`, status: resp.status }
  let data = null
  try { data = JSON.parse(resp.body) } catch {}
  return { ok: true, status: 200, data }
}

module.exports = { RateLimitError, configure, acquire, observe, hint, budgeted }
