// The header orb's line while the local backend builds market history. The crawl counts fetch
// candidates only, so a league with nothing to fetch is named without a counter.
export function backfillLabel(d) {
  if (d.phase === 'leagues') return 'Building your dashboard — fetching leagues…'
  const league = d.league || 'market history'
  if (!d.league_total) return `Building your dashboard — checking ${league}…`
  return `Building your dashboard — ${league} · ${d.league_done}/${d.league_total} · ${Math.round(d.pct || 0)}%`
}
