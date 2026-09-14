import { setup } from 'xstate'

// Lifecycle of a single live-ping's teleport button. The component drives the async
// teleport and reports the outcome as events; the machine enforces the legal transitions
// so the button/orb always reflect a real state:
//   fresh → sending → pending (teleport landed) | gone (sold/contested) | rateLimited
//   fresh → stale (auto after N s) → sending …
//   fresh/stale → expired (token past its ~5-min life)
export const pingMachine = setup({
  types: { events: {} },
}).createMachine({
  id: 'ping',
  initial: 'fresh',
  states: {
    fresh: {
      on: { SEND: 'sending', EXPIRE: 'expired', GONE: 'gone' },
      after: { 45000: 'stale' },
    },
    stale: {
      on: { SEND: 'sending', EXPIRE: 'expired', GONE: 'gone' },
    },
    sending: {
      on: { OK: 'pending', FALSE: 'gone', RATE: 'rateLimited', ERR: 'stale' },
    },
    pending: {                 // teleport succeeded — you're travelling to the hideout
      on: { GONE: 'gone', RESET: 'fresh' },
    },
    rateLimited: {
      on: { RESET: 'fresh' },
      after: { 30000: 'fresh' },
    },
    gone: { type: 'final' },   // sold / contested
    expired: { on: { GONE: 'gone' } },
  },
})

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
