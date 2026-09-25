// The small terms every kind shares: rarity, a selected modifier with its optional minimum,
// and the joins. `placement` is the one reading of "where does the roll sit relative to the
// token"; the sync script runs it once per row and ships the answer as `num`.
import { minRegex } from './number.js'
import { escapeRe, formsOf, linesOf } from './shortest.js'

// "y: r" / "y: (m|r)"; nothing when none or all are picked.
export function rarity({ normal, magic, rare }) {
  if ((normal && magic && rare) || (!normal && !magic && !rare)) return null
  const parts = [normal ? 'n' : '', magic ? 'm' : '', rare ? 'r' : ''].filter(Boolean)
  return parts.length === 1 ? `"y: ${parts[0]}"` : `"y: (${parts.join('|')})"`
}

// Where a minimum can go for a modifier: { side: 'before' | 'after' | 'inside', gap, after }
// or null when no minimum makes sense. `side` is the token's place relative to the roll
// ('inside' when the token bridges the roll with ".*"); `gap` is false when the token touches
// the roll, so nothing may be put between them; `after` is the character printed right after
// the roll ("%", " "), the number's anchor. Null for a modifier printed in several forms, on two
// lines, with two rolls, or whose token sits on the other line from its roll.
export function placement(text, regex) {
  if (formsOf(text).length > 1) return null
  const lines = linesOf(text)
  if (lines.length > 1) return null
  const line = lines[0]
  if ((line.match(/#/g) || []).length !== 1) return null
  const at = line.indexOf('#')
  const after = line[at + 1] ?? ''
  const printed = line.replaceAll('#', '0')
  const bridge = regex.indexOf('.*')
  try {
    if (bridge !== -1) {
      const left = new RegExp(regex.slice(0, bridge), 'i').exec(printed)
      const right = new RegExp(regex.slice(bridge + 2), 'i').exec(printed.slice(at + 1))
      return left && right && left.index + left[0].length <= at ? { side: 'inside', gap: true, after } : null
    }
    const m = new RegExp(regex, 'i').exec(printed)
    if (!m) return null
    const end = m.index + m[0].length
    if (end <= at) return { side: 'before', gap: end < at, after }
    if (m.index > at) return { side: 'after', gap: m.index > at + 1, after }
    return null
  } catch { return null }
}

// The token, with "at least min" bolted onto the side the roll lives, when asked for and when
// the table says a minimum is possible. The number is anchored on the character printed after
// the roll, so a longer number is read whole and a shorter one never matches; a token that
// touches the roll is glued straight on; a bridged token takes the number inside its bridge.
export function selectedMod(mod, sel, round10) {
  const p = mod.num
  const num = p ? minRegex(String(Number(sel?.min) || 0), round10).replace(/\./g, '\\d') : ''
  if (!num) return mod.regex
  const anchor = escapeRe(p.after)
  if (p.side === 'before') return `${mod.regex}${p.gap ? '.*' : ''}${num}${anchor}`
  if (p.side === 'after') return `${num}${p.gap ? anchor + '.*' : ''}${mod.regex}`
  const bridge = mod.regex.indexOf('.*')
  return `${mod.regex.slice(0, bridge)}.*${num}${anchor}.*${mod.regex.slice(bridge + 2)}`
}

const byId = (table) => new Map(table.mods.map(m => [m.id, m]))

// Wanted mods as quoted terms: one alternation for 'any', one term each for 'all'.
export function wantedTerms(want, wantMode, table, round10) {
  const mods = byId(table)
  const parts = (want || []).map(sel => { const m = mods.get(sel.id); return m ? selectedMod(m, sel, round10) : null }).filter(Boolean)
  if (!parts.length) return []
  return wantMode === 'all' ? parts.map(p => `"${p}"`) : [`"${parts.join('|')}"`]
}

// Unwanted mods as one negated term.
export function avoidTerm(avoid, table) {
  const mods = byId(table)
  const parts = (avoid || []).map(id => mods.get(id)?.regex).filter(Boolean)
  return parts.length ? `"!${parts.join('|')}"` : null
}

// Terms joined with spaces, blanks dropped; `anchor` is prepended to a non-empty string unless
// one of the terms already anchors on this kind (so a search in a stash tab holding both
// waystones and tablets never keeps the other kind).
export function joinTerms(terms, anchor = null, anchored = false) {
  const kept = terms.filter(t => t !== null && t !== undefined && t !== '')
  if (!kept.length) return ''
  if (anchor && !anchored) kept.unshift(anchor)
  return kept.join(' ').trim()
}
