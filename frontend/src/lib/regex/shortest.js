// The token for a modifier: the shortest regex that matches every way the item prints that
// modifier and nothing else the tooltip can show. Runs at sync time
// (frontend/scripts/sync-regex-data.mjs); frontend/test/regex-data.test.mjs re-checks the
// shipped result against the same rule.
//
// Pool text grammar: "#" is where a roll is printed (items print a plain number there);
// "a | b" is a modifier that prints two lines, the token may match either;
// "a ~ b" is one modifier the game prints in different forms ("an additional Shrine",
// "3 additional Shrines"), the token must match every form.

const ROLL = '12'   // stands in for a printed roll

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The text as the item prints it, a number standing in for every placeholder.
export const matchable = (text) => text.replaceAll('#', ROLL)

// The lines a modifier prints together (either one satisfies the token).
export const linesOf = (text) => text.split(' | ')
// The forms a modifier may print as (every one must satisfy the token).
export const formsOf = (text) => text.split(' ~ ')

// A body with ^ and $ where it touches a line end: the ways to anchor it.
const anchored = (body, atStart, atEnd) => [body, ...(atStart ? ['^' + body] : []), ...(atEnd ? [body + '$'] : []), ...(atStart && atEnd ? ['^' + body + '$'] : [])]

// The printed line with a mask of the characters a token may not use: a roll's digits, and
// any digit at all ("3 out of every 10 seconds" would otherwise hand out the token "3", which
// every "Revives Available: 3" matches).
function masked(line) {
  const disp = matchable(line)
  const mask = []
  for (const ch of line) {
    if (ch === '#') for (let i = 0; i < ROLL.length; i++) mask.push(true)
    else mask.push(/\d/.test(ch))
  }
  return { disp, mask }
}
const clean = (mask, a, b) => { for (let i = a; i < b; i++) if (mask[i]) return false; return true }

// Plain candidates, shortest first: substrings of the line.
function* plain(line) {
  const { disp, mask } = masked(line)
  const n = disp.length
  for (let len = 1; len <= n; len++) for (let a = 0; a + len <= n; a++) {
    const b = a + len
    if (clean(mask, a, b)) yield* anchored(escapeRe(disp.slice(a, b)), a === 0, b === n)
  }
}

// Bridged candidates, shortest first by total text: a piece from before a roll, ".*", a piece
// from after it, for modifiers whose only distinguishing text sits on both sides of the number
// ("Deferring Favours ... costs #% increased Tribute" beside "Rerolling ... costs #% reduced
// Tribute" gives "^def.*% i"). Pieces are short; the bridge does the reaching.
const PIECE = 10
function* bridged(line) {
  const { disp, mask } = masked(line)
  const n = disp.length
  const holes = []
  for (let i = 0; i < n; i++) if (mask[i] && (i === 0 || !mask[i - 1])) { let j = i; while (j < n && mask[j]) j++; holes.push([i, j]) }
  const pieces = (from, to) => { const out = []; for (let a = from; a < to; a++) for (let b = a + 1; b <= to && b - a <= PIECE; b++) if (clean(mask, a, b)) out.push([a, b]); return out }
  const sides = holes.map(([hs, he]) => [pieces(0, hs), pieces(he, n)])
  for (let total = 2; total <= 2 * PIECE; total++) {
    for (const [lefts, rights] of sides) for (const [la, lb] of lefts) {
      const rl = total - (lb - la)
      if (rl < 1 || rl > PIECE) continue
      for (const [ra, rb] of rights) {
        if (rb - ra !== rl) continue
        yield* anchored(`${escapeRe(disp.slice(la, lb))}.*${escapeRe(disp.slice(ra, rb))}`, la === 0, rb === n)
      }
    }
  }
}

// tokens[i] is the token for texts[i]. Throws when a modifier has no unique token at all.
export function shortestUnique(texts, stoplist = []) {
  const printed = texts.map(t => formsOf(t).flatMap(f => linesOf(f).map(matchable)))
  const stop = stoplist.map(matchable).join('\n')
  return texts.map((text, i) => {
    // Everything the token must NOT match, one string, one test per candidate ("m" keeps ^ and $
    // per line, as the search box does). The other mods first: they reject most candidates,
    // the long name vocabulary rarely does.
    const others = []
    for (const [j, lines] of printed.entries()) if (j !== i) others.push(...lines)
    const haystack = others.join('\n') + '\n' + stop
    const forms = formsOf(text).map(f => linesOf(f).map(matchable))
    const ok = (cand) => {
      const re = new RegExp(cand, 'im')
      return forms.every(lines => lines.some(l => re.test(l))) && !re.test(haystack)
    }
    // Candidates come from the shortest form; every form must still match.
    const source = formsOf(text).sort((a, b) => a.length - b.length)[0]
    let best = null
    for (const gen of [plain, bridged]) {
      for (const line of linesOf(source)) {
        for (const cand of gen(line)) {
          if (best && cand.length >= best.length) break
          if (ok(cand)) { best = cand; break }
        }
      }
      if (best) break
    }
    if (!best) throw new Error(`no unique token for "${text}"`)
    return best
  })
}
