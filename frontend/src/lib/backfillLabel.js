// The header orb's line while the local backend crawls market history. The crawl counts fetch
// candidates only, so a league with nothing to fetch is named without a counter. Only a first build
// (`building`: a league with no stored history) says "Building your dashboard"; the routine catch-up
// says "Refreshing".
export function backfillLabel(d) {
  const what = d.building ? 'Building your dashboard' : 'Refreshing market data'
  if (d.phase === 'leagues') return `${what} — fetching leagues…`
  const league = d.league || 'market history'
  if (!d.league_total) return `${what} — checking ${league}…`
  return `${what} — ${league} · ${d.league_done}/${d.league_total} · ${Math.round(d.pct || 0)}%`
}
