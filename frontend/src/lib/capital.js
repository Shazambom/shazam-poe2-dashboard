// A holding's worth by the volume rule (CLAUDE.md). Pure: the Stash view renders it.
// { amount, cur, ref }: the holding at the rate of the market that trades it (server `native`), with its
// reference value for the display's approximation of a number too large to read. null for cash (its
// quantity is already its native amount), without a value or a market, and while the market syncs.
export function holdingWorth(v, { syncing = false } = {}) {
  if (!v || v.value_ref == null || syncing || !v.native || v.native.cur === v.currency) return null
  return { ...v.native, ref: v.value_ref }
}

// The status poll's next delay: fast while Capital is syncing (the digest sync lands in seconds,
// and the card should not wait a full period to clear), the normal period otherwise.
export const SYNC_POLL_MS = 3000
export const nextPollMs = (capital, ms) => (capital?.syncing ? SYNC_POLL_MS : ms)
