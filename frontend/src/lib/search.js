// The one search every box uses (docs/search-design.md).
//
// Today's picker rule, applied word by word, so it just works for everyone (a trade-site "~" folds away):
// 1. Fold both sides: case, accents, apostrophes and hyphens dropped; other punctuation is a space; letters
//    of any script kept. A leading "~" is ignored; text that is only punctuation matches as typed; a blank box
//    (or a lone "~") lists everything.
// 2. A name matches when every typed word is in it, in any order. A typed number matches a modifier's "#".
// 3. Tiers, as today: the whole name or the exact id; then names whose first words start with the typed
//    words; then the rest, and after them an id containing the text as typed; then keyword hits. Shorter
//    names first within a tier, then the caller's list order.
// 4. Only when nothing matches: typo tolerance, 1 slip per word of 4+ letters, 2 from 8 (Algolia's
//    defaults), fewest slips first, names before keywords, shorter names first. It never adds noise to a search
//    that works.

export const norm = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/['’`-]/g, '').replace(/#/g, ' # ').replace(/[^\p{L}\p{N}#]+/gu, ' ').trim()

// A typed word `x` against a name word `w`: its start (or anywhere in it), and a number fills a "#".
const hit = (x, w, anywhere = false) => (anywhere ? w.includes(x) : w.startsWith(x)) || (w === '#' && /^\d+$/.test(x))

// Fewest slips (restricted Damerau-Levenshtein) that turn `x` into the start of `w`; Infinity past the budget.
function slips(x, w) {
  if (hit(x, w)) return 0
  const k = x.length >= 8 ? 2 : x.length >= 4 ? 1 : 0
  if (!k) return Infinity
  let pp, p = Array.from({ length: w.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const c = [i]
    for (let j = 1; j <= w.length; j++) {
      c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (x[i - 1] === w[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && x[i - 1] === w[j - 2] && x[i - 2] === w[j - 1]) c[j] = Math.min(c[j], pp[j - 2] + 1)
    }
    if (Math.min(...c) > k) return Infinity
    pp = p; p = c
  }
  const best = Math.min(...p.slice(1))
  return best <= k ? best : Infinity
}

// A folded text's tier for the folded query: 0 whole, 1 first words start with the typed words, 2 all
// typed words somewhere; -1 no match.
function tier(t, q, qw) {
  if (t === q) return 0
  const tw = t.split(' ')
  if (!qw.every(x => tw.some(w => hit(x, w, true)))) return -1
  return qw.every((x, i) => tw[i] && hit(x, tw[i])) ? 1 : 2
}

// Keys are [tier, tie-break]; smaller first. Array#sort is stable, so equal keys keep list order.
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1]
const rankBy = (rows, key) => rows.map(r => [r.it, key(r)]).filter(x => x[1]).sort((a, b) => cmp(a[1], b[1])).map(x => x[0])

// `items` matching `q`, best first. `fields(item)` → [names, keywords?, id?]. A blank query returns `items`.
// Boxes that keep their own order use `matching` below.
export function search(items, q, fields) {
  const raw = String(q ?? '').trim().replace(/^~+\s*/, '').toLowerCase(), qn = norm(raw)   // a leading ~ is trade-site habit
  if (!qn) return raw ? items.filter(it => fields(it)[0].some(n => String(n ?? '').toLowerCase().includes(raw))) : items   // only punctuation: as typed
  const qw = qn.split(' ')
  const rows = items.map(it => { const [names, keys = [], id = ''] = fields(it); return { it, names: names.map(norm), keys: keys.map(norm), id: String(id).toLowerCase() } })
  const hits = rankBy(rows, ({ names, keys, id }) => {
    let best = id === raw ? [0, 0] : null
    for (const t of names) { const r = tier(t, qn, qw), k = [r, r ? t.length : 0]; if (r >= 0 && (!best || cmp(k, best) < 0)) best = k }
    if (!best && id.includes(raw)) best = [2, Infinity]
    if (!best) for (const t of keys) { const r = tier(t, qn, qw); if (r >= 0 && (!best || 3 + r < best[0])) best = [3 + r, 0] }
    return best
  })
  if (hits.length) return hits
  const cost = (t) => qw.reduce((sum, x) => sum + Math.min(...t.split(' ').map(w => slips(x, w))), 0)
  return rankBy(rows, ({ names, keys }) => {   // fewest slips, names before keywords, then shorter names
    const n = Math.min(Infinity, ...names.map(cost)), k = Math.min(Infinity, ...keys.map(cost))
    return n <= k ? (n < Infinity ? [n, Math.min(...names.map(t => t.length))] : null) : [k + 0.5, 0]
  })
}

// The rows a filter box keeps, in the box's own order (every row for a blank search). `names(row)` → its texts.
export function matching(rows, q, names) {
  const hit = new Set(search(rows, q, r => [names(r)]))
  return rows.filter(r => hit.has(r))
}
