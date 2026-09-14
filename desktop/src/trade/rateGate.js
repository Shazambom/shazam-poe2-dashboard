// Header-mirroring rate limiter for the trade API, per policy (search/fetch/whisper).
// Mirrors the algorithm already shipped in backend/app/gateway.py (Policy.observe): read
// GGG's X-Rate-Limit-* / -State headers after each response, and refuse to fire when a
// tier is near its cap or actively restricted — a clean "retry in Ns" instead of a 429
// storm. Node and Python can't share a runtime, so this is a small faithful port.

class RateLimitError extends Error {
  constructor(retryAfter) { super(`rate-limited, retry in ${retryAfter}s`); this.retryAfter = retryAfter; this.code = 'RATE_LIMITED' }
}

// Parse "hits:period:restrict" (or limit:period:restrict) triples separated by commas.
function parseTriples(v) {
  if (!v) return []
  return String(v).split(',').map(t => {
    const [a, b, c] = t.split(':').map(n => parseInt(n, 10) || 0)
    return { a, b, c }   // limit/hits, period(seconds), restrict/restrictedFor
  })
}

const _state = {}   // policy -> { retryAt, tiers: [{limit, period, hits}] }
const LATENCY_FUDGE = 0.5   // seconds, like gateway.py DESYNC_FIX

function _get(policy) { return (_state[policy] ||= { retryAt: 0, tiers: [] }) }

// Called after every response: reconcile our view to the server's headers.
function observe(policy, headers) {
  const st = _get(policy)
  const h = {}
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = Array.isArray(v) ? v[0] : v
  const rules = (h['x-rate-limit-rules'] || '').split(',').map(s => s.trim()).filter(Boolean)
  let worstRestrict = 0
  const tiers = []
  for (const rule of rules) {
    const limits = parseTriples(h[`x-rate-limit-${rule.toLowerCase()}`])
    const states = parseTriples(h[`x-rate-limit-${rule.toLowerCase()}-state`])
    limits.forEach((lim, i) => {
      const stt = states[i] || { a: 0, b: lim.b, c: 0 }
      tiers.push({ limit: lim.a, period: lim.b, hits: stt.a })
      if (stt.c > worstRestrict) worstRestrict = stt.c    // restrictedFor seconds
    })
  }
  if (tiers.length) st.tiers = tiers
  if (worstRestrict > 0) st.retryAt = Date.now() + (worstRestrict + LATENCY_FUDGE) * 1000
}

// Note an HTTP 429 (with optional Retry-After header) — back off.
function observe429(policy, headers) {
  const h = {}
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = Array.isArray(v) ? v[0] : v
  const retry = parseInt(h['retry-after'], 10) || 30
  _get(policy).retryAt = Date.now() + (retry + LATENCY_FUDGE) * 1000
}

// Throw RateLimitError if firing now would violate the limit; otherwise allow.
// preventQueueCreation-style: fail fast rather than silently stalling.
function check(policy) {
  const st = _get(policy)
  const now = Date.now()
  if (now < st.retryAt) throw new RateLimitError(Math.ceil((st.retryAt - now) / 1000))
  // Soft pre-check: if any tier is at its cap, refuse for ~one period.
  for (const t of st.tiers) {
    if (t.limit && t.hits >= t.limit) throw new RateLimitError(Math.max(1, t.period))
  }
}

function snapshot() {
  const out = {}
  for (const [p, st] of Object.entries(_state)) {
    out[p] = {
      retryInMs: Math.max(0, st.retryAt - Date.now()),
      tiers: st.tiers.map(t => `${t.hits}/${t.limit} per ${t.period}s`),
    }
  }
  return out
}

module.exports = { RateLimitError, observe, observe429, check, snapshot }
