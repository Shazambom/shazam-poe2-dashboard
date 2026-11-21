import { parseNum } from './numInput.js'
import { matching } from './search.js'
// The Stash tab: the user's holdings grouped by league mechanic, with net worth and liquid net worth.
// Pure (StashView renders it). Rows are /api/capital rows ({ currency, qty, value_ref, realizable_ref, … }).
//
// Groups are the game's own Currency Exchange category, served per currency as `group` by
// /api/currencies (backend currencies.Registry.groups) — never a list kept here. Choices are the user's
// "count toward liquid net worth" switches, { currency: bool }, stored in settings `stash_counted`.

// Whether a holding counts as liquid: the user's switch, else `dflt` — the one default, which the backend
// owns (settings.STASH_COUNTED_BY_DEFAULT, served as /api/capital `counted_by_default`); only the user's
// own choices are ever stored.

// The default cash: always listed in the editor (never removable), and arbitrage capital unless the user
// switches it off (backend arbitrage.CASH).
export const CASH = ['chaos', 'exalted', 'divine']

// A holding whose currency has no group yet (the registry hasn't loaded) waits here, unguessed.
export const UNGROUPED = 'Other'

// A group this small (share of net worth) starts folded so the screen opens on what matters.
export const FOLD_SHARE = 0.005

export const isCounted = (id, choices, dflt) => choices?.[id] ?? !!dflt

const num = (v) => (Number.isFinite(v) ? v : 0)

export const netWorth = (rows) => (rows || []).reduce((a, r) => a + num(r.value_ref), 0)

// What the switched-on holdings would realize (the backend's realizable value: never below 0).
export const liquidNetWorth = (rows, choices, dflt) =>
  (rows || []).reduce((a, r) => a + (isCounted(r.currency, choices, dflt) ? num(r.realizable_ref) : 0), 0)

// The add bar: `n` more of currency `id` — a new holding, or added to one already held. Unchanged when
// nothing is picked or the amount isn't a positive count.
export function addAmount(qty, id, n) {
  if (!id || !(Number(n) > 0)) return qty
  return { ...qty, [id]: String((Number(qty[id]) || 0) + Math.trunc(Number(n))) }
}

// The add bar's amount, read the way the app reads typed numbers (40k, 1,000, 3*12): a whole count above
// zero, else null.
export function parseAmount(raw) {
  const n = parseNum(raw)
  return n != null && n >= 1 ? Math.trunc(n) : null
}

// A quantity box holds a whole, non-negative count ('' while the box is cleared).
export function cleanQty(v) {
  const s = String(v ?? '').trim()
  if (s === '') return ''
  const n = Number(s)
  return Number.isFinite(n) ? String(Math.max(0, Math.trunc(n))) : ''
}

// [{ name, rows, value_ref, counted_ref, counted: true | false | 'some' }], biggest group and holding
// first. `counted_ref` is the switched-on holdings at paper (the worth bar's counted share).
export function stashGroups(rows, groupOf, choices, dflt) {
  const by = new Map()
  for (const r of rows || []) {
    const name = groupOf?.[r.currency] || UNGROUPED
    if (!by.has(name)) by.set(name, [])
    by.get(name).push(r)
  }
  const out = [...by].map(([name, rs]) => {
    rs.sort((a, b) => num(b.value_ref) - num(a.value_ref))
    const onRows = rs.filter(r => isCounted(r.currency, choices, dflt))
    const on = onRows.length
    return {
      name, rows: rs,
      value_ref: netWorth(rs),
      counted_ref: netWorth(onRows),
      counted: on === rs.length ? true : on === 0 ? false : 'some',
    }
  })
  return out.sort((a, b) => b.value_ref - a.value_ref)
}

// The choices that flip a whole group: all on when any is off, otherwise all off.
export function flipGroup(group) {
  const to = group.counted !== true
  return Object.fromEntries(group.rows.map(r => [r.currency, to]))
}

export const foldedByDefault = (group, total) => total > 0 && group.value_ref / total < FOLD_SHARE

// A group is folded by the user's stored choice, else by size; a search opens every group it matches.
export const isFolded = (group, folds, total, q) =>
  !String(q || '').trim() && (folds?.[group.name] ?? foldedByDefault(group, total))
// The folds after a click on a group's header. Mid-search the header shows no fold, so nothing is saved.
export const flipFold = (group, folds, total, q) =>
  String(q || '').trim() ? folds : { ...folds, [group.name]: !isFolded(group, folds, total, '') }

// Convert /api/capital rows into the editor's { currency: qty } map, always including default CASH rows.
export function capitalQty(cap) {
  const r = Object.fromEntries(CASH.map(p => [p, 0]))
  for (const x of cap?.rows || []) r[x.currency] = x.qty
  return r
}

// Track unsaved edits made since the last committed save (while debouncing or held during a sales fetch):
//   - { kind: 'count', value } : the user typed an absolute total (a recount — do not add sales on top)
//   - { kind: 'remove' }       : the user removed the holding
//   - { kind: 'add', delta }   : the user added +delta via the Add bar (rebases onto authoritative server total)
export function recordPendingEdit(edits, currency, edit) {
  if (!edits || !currency || !edit) return
  if (edit.kind === 'add') {
    const prev = edits.get(currency)
    if (prev?.kind === 'count') {
      edits.set(currency, { kind: 'count', value: String((Number(prev.value) || 0) + edit.delta) })
    } else if (prev?.kind === 'remove') {
      edits.set(currency, { kind: 'count', value: String(edit.delta) })
    } else {
      edits.set(currency, { kind: 'add', delta: (prev?.delta || 0) + edit.delta })
    }
    return
  }
  edits.set(currency, edit)
}

// Currencies whose total was recounted or removed in `edits` (sent as `counted` to PUT /api/capital).
export function countedFromEdits(edits) {
  if (!edits || !edits.size) return []
  const out = []
  for (const [c, edit] of edits) if (edit.kind === 'count' || edit.kind === 'remove') out.push(c)
  return out
}

// Re-compose failed edits under any newer edits made while the failed PUT was in flight,
// preserving chronological order (e.g., failed recount 125 + newer add +5 -> count 130).
export function restoreFailedEdits(failedEdits, newerEdits) {
  const merged = new Map(failedEdits || [])
  for (const [c, edit] of newerEdits || []) recordPendingEdit(merged, c, edit)
  return merged
}

// Reconcile authoritative post-credit `/api/capital` with any unsaved edits held in the editor.
// When no edits are pending, returns the server's holdings with `needsSave: false` (no redundant PUT, and
// immune to startup hydration races). Pending recounts/removals keep the user's absolute count; pending
// Add-bar deltas rebase onto the server's credited balance.
export function reconcileCapital(post, pendingEdits) {
  const base = capitalQty(post)
  if (!pendingEdits || !pendingEdits.size) return { qty: base, needsSave: false }
  const out = { ...base }
  for (const [c, edit] of pendingEdits) {
    if (edit.kind === 'remove') delete out[c]
    else if (edit.kind === 'count') out[c] = edit.value
    else if (edit.kind === 'add') out[c] = String((Number(out[c]) || 0) + edit.delta)
  }
  return { qty: out, needsSave: true }
}

// What a sales fetch says: how many sales were new, and whether the holdings changed.
export function salesToast({ new: n = 0, credited = 0 } = {}) {
  if (!n) return 'Up to date'
  const sales = `${n} new sale${n === 1 ? '' : 's'}`
  return credited ? `${sales} · added to your holdings` : sales
}

// Find in stash: the holdings the shared search keeps, by name (a holding without one by its id).
export const stashMatches = (rows, q) => new Set(matching(rows, q, r => [r.name || r.currency]))

// The Arbitrage rail: holdings the route search may start from (server `arbitrage` flag), biggest first.
export const arbitrageHoldings = (capital) =>
  (capital?.rows || []).filter(r => r.arbitrage && r.qty > 0).sort((a, b) => num(b.value_ref) - num(a.value_ref))

// A group's accent: the `--grp-<category>` token in styles.css, or the neutral muted ink for a category
// the game adds before it has a colour. Colour is styling only — it never decides a group.
export const groupSlug = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
export const groupAccent = (name) => `var(--grp-${groupSlug(name)}, var(--muted))`
