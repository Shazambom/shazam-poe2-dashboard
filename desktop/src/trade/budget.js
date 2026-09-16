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

module.exports = { RateLimitError, configure, acquire, observe, hint }
