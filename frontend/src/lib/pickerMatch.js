// The currency picker's search order: an exact name or id first ("vaal" is Vaal Orb), then names that start
// with the text (shorter names first: "vaal" puts Vaal Orb before the Vaal Infusers), then names that contain
// it (or whose id does), then hidden keyword hits ("ruby" is the Ruby jewel before the Ruby Charm) — ties in
// the list's own order. A blank search lists everything.
export function rankMatches(options, q) {
  const t = String(q || '').trim().toLowerCase()
  if (!t) return options
  const name = (o) => o.name.toLowerCase()
  const direct = options.filter(o => name(o).includes(t) || String(o.id).toLowerCase().includes(t))
  const rank = (o) => (name(o) === t || String(o.id).toLowerCase() === t ? 0 : name(o).startsWith(t) ? 1 : 2)
  const short = (a, b) => (rank(a) === 1 && rank(b) === 1 ? a.name.length - b.name.length : 0)
  const ordered = direct.map((o, i) => [o, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || short(a[0], b[0]) || a[1] - b[1]).map(([o]) => o)
  const viaKeyword = options.filter(o => !direct.includes(o) && o.keywords?.some(k => k.toLowerCase().includes(t)))
  return [...ordered, ...viaKeyword]
}
