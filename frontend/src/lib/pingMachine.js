// Lifecycle of a single live-ping's teleport button. The component drives the async
// teleport and reports the outcome as events; the transition table enforces the legal transitions
// so the button/orb always reflect a real state:
//   fresh → sending → pending (teleport landed) | gone (sold/contested) | rateLimited
//   fresh → stale (auto after 45 s) → sending …
//   fresh/stale → expired (token past its ~5-min life)
const TRANSITIONS = {
  fresh:       { SEND: 'sending', EXPIRE: 'expired', GONE: 'gone', STALE: 'stale' },
  stale:       { SEND: 'sending', EXPIRE: 'expired', GONE: 'gone' },
  sending:     { OK: 'pending', FALSE: 'gone', RATE: 'rateLimited', ERR: 'stale' },
  pending:     { GONE: 'gone', RESET: 'fresh' },
  rateLimited: { RESET: 'fresh' },
  gone:        {},
  expired:     { GONE: 'gone' },
}

export const TIMED_TRANSITIONS = {
  fresh:       { ms: 45000, event: 'STALE' },
  rateLimited: { ms: 30000, event: 'RESET' },
}

export function pingTransition(state, event) {
  const type = typeof event === 'string' ? event : event?.type
  if (type === 'NEW_PING') return 'fresh'
  return TRANSITIONS[state]?.[type] ?? state
}

// UI presentation per state — label, whether the button fires, and a css modifier.
export function buttonView(state) {
  switch (state) {
    case 'fresh': return { label: 'Travel to hideout', enabled: true, cls: 'hot' }
    case 'stale': return { label: 'Travel (stale)', enabled: true, cls: 'stale' }
    case 'sending': return { label: 'Travelling…', enabled: false, cls: 'sending' }
    case 'pending': return { label: 'Sent ✓', enabled: false, cls: 'pending' }
    case 'rateLimited': return { label: 'Rate-limited', enabled: false, cls: 'rate' }
    case 'gone': return { label: 'Sold / gone', enabled: false, cls: 'gone' }
    case 'expired': return { label: 'Expired', enabled: false, cls: 'expired' }
    default: return { label: 'Travel to hideout', enabled: true, cls: 'hot' }
  }
}
