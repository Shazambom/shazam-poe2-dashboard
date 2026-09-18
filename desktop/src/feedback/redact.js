// A feedback report never carries a credential. Two layers, in order: an ALLOW-LIST for the two
// settings documents (unknown keys are dropped, fail-closed), then redactDeep over everything —
// every string scrubbed of secret shapes, every credential-named key dropped. The account name is
// not a secret here (it is in the screenshots anyway); the dialog says so.
'use strict'

// /api/settings + desktop-settings.json: the keys a report may carry. Anything not listed is dropped.
const SETTINGS_KEYS = [
  'league', 'reference', 'watchlist', 'extra_pairs', 'hub_count', 'theme', 'gold_model', 'max_steps',
  'max_start_fraction', 'live_max_age_s', 'live_top_n', 'live_min_age_s', 'min_refetch_s', 'routes_cache_s',
  'background_sweep', 'batch_pad', 'batch_max_have', 'digest_max_age_h', 'allow_digest_edges', 'allow_recipe_edges',
  'min_edge_volume_ref_per_h', 'min_edge_depth', 'rank_weights', 'volume_window_h', 'step_overhead_min',
  'gold_value_per_1k', 'notifications', 'ee2History', 'filters',
  // desktop-settings.json
  'betaChannel', 'customBackdrop', 'focusHotkey',
]

const DROP_KEY = /sess|cookie|token|secret|password|authorization/i

const SECRET_PATTERNS = [
  /POESESSID\s*[=:]\s*\S+/gi,
  /Bearer\s+[\w.\-]+/g,
  /^(Set-)?Cookie:.*$/gim,
  /"(access|refresh|id)_token"\s*:\s*"[^"]*"/gi,
  /gAAAAA[\w=\-]+/g,                                  // Fernet tokens
  /client_secret\S*/gi,
  /[?&](code|state)=[^&\s]+/g,                        // OAuth callback URLs
]
// ≥ 32 hex/base64 chars on a line that also mentions a credential word.
const KEY_LINE = /token|secret|key|sess/i
const LONG_BLOB = /[A-Za-z0-9+/=_\-]{32,}/g

function scrubText(s) {
  let out = String(s)
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]')
  return out.split('\n').map(line => (KEY_LINE.test(line) ? line.replace(LONG_BLOB, '[redacted]') : line)).join('\n')
}

function redactDeep(value, seen = new Set(), depth = 0) {
  if (typeof value === 'string') return scrubText(value)
  if (!value || typeof value !== 'object') return value
  if (seen.has(value) || depth > 32) return undefined
  seen.add(value)
  if (Array.isArray(value)) return value.map(v => redactDeep(v, seen, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) {
    if (DROP_KEY.test(k)) continue
    out[k] = redactDeep(v, seen, depth + 1)
  }
  return out
}

function pickAllowed(obj, keys) {
  const out = {}
  if (!obj || typeof obj !== 'object') return out
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k]
  return out
}

module.exports = { SETTINGS_KEYS, SECRET_PATTERNS, pickAllowed, scrubText, redactDeep }
