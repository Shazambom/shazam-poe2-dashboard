// The exact-number box's rule (components/Num.jsx). Pure.

// What a keystroke applies: the whole number typed when it lies in [min, max], else null (wait).
// A cleared or out-of-range box mid-edit must not snap, or the next digit lands on the snapped value.
export function typed(raw, min, max) {
  if (String(raw).trim() === '') return null
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= min && n <= max ? n : null
}

// What the box settles to when it loses focus: clamped to the range; blank or garbage is the minimum.
export function settle(raw, min, max) {
  if (String(raw).trim() === '') return min
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min
}

// A number as people type it: `1.5` or `1,5`, `1,000`, `40k`, `2m`, and sums (`3*12`, `3 x 12`,
// `(2+3)*4`). Null when it isn't a number of zero or more (the box goes back to its last value).
export function parseNum(raw) {
  let s = String(raw ?? '').trim().toLowerCase()
  if (!s) return null
  // thousands groups first (1,000 · 12,345,678); a group can't start with 0, so 0,005 stays a decimal
  s = s.replace(/(?<![\d.])[1-9]\d{0,2}(?:,\d{3})+(?![\d,])/g, m => m.replace(/,/g, '')).replace(/,/g, '.').replace(/[x×]/g, '*')
  const toks = s.match(/\d*\.?\d+[km]?|[-+*/()]|\S/g) || []
  let i = 0
  const num = (t) => {
    const m = /^(\d*\.?\d+)([km]?)$/.exec(t ?? '')
    return m ? Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1) : null
  }
  const factor = () => {
    if (toks[i] === '(') { i++; const v = expr(); if (toks[i++] !== ')') throw 0; return v }
    const v = num(toks[i++]); if (v == null) throw 0; return v
  }
  const term = () => { let v = factor(); while (toks[i] === '*' || toks[i] === '/') v = toks[i++] === '*' ? v * factor() : v / factor(); return v }
  const expr = () => { let v = term(); while (toks[i] === '+' || toks[i] === '-') v = toks[i++] === '+' ? v + term() : v - term(); return v }
  try {
    const v = expr()
    return i === toks.length && Number.isFinite(v) && v >= 0 ? v : null
  } catch { return null }
}
