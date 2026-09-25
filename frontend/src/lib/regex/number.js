// Numbers in the in-game search box. The box takes a regex and matches it against an item's
// tooltip text, so "at least 25" has to be spelled as an alternation of digit patterns.
//
// One idea does all of it: a span of same-width integers [from, to] is the shared prefix, then
// a partial head (the first number's own digits), a full run of whole tens/hundreds, and a
// partial tail (the last number's own digits). Every function below is a union of such spans
// over the digit widths it needs. Pure; proven by frontend/test/regex-number.test.mjs (exhaustive
// sweeps of the input space) and held to the reference implementation's outputs by
// frontend/test/regex-number-golden.test.mjs. In these strings `.` means "any digit"; a caller
// that needs a literal class turns it into \d (terms.js does).

const digitsOf = (v) => String(v ?? '').match(/\d/g)
const floor10 = (n) => Math.floor(n / 10) * 10

// A class for the digits lo..hi: the digit itself, `any` for 0..9, else "[lo-hi]".
const digitClass = (lo, hi, any) => lo === hi ? String(lo) : lo === 0 && hi === 9 ? any : `[${lo}-${hi}]`

// Alternatives matching every integer written with the same number of digits as `from` and
// `to`, from..to inclusive. `any` is the one-digit wildcard to use.
function span(from, to, any) {
  if (from === to) return [from]
  let p = 0
  while (from[p] === to[p]) p++
  const prefix = from.slice(0, p)
  const lo = Number(from[p]), hi = Number(to[p])
  const restLen = from.length - p - 1
  const loRest = from.slice(p + 1), hiRest = to.slice(p + 1)
  const headPartial = /[1-9]/.test(loRest)          // the first number does not start its own run of tens
  const tailPartial = /[0-8]/.test(hiRest)          // the last number does not end its run
  const out = []
  if (headPartial) for (const s of span(loRest, '9'.repeat(restLen), any)) out.push(`${prefix}${lo}${s}`)
  const runLo = lo + (headPartial ? 1 : 0), runHi = hi - (tailPartial ? 1 : 0)
  if (runLo <= runHi) out.push(`${prefix}${digitClass(runLo, runHi, any)}${any.repeat(restLen)}`)
  if (tailPartial) for (const s of span('0'.repeat(restLen), hiRest, any)) out.push(`${prefix}${hi}${s}`)
  return out
}

const joined = (parts) => parts.length === 1 ? parts[0] : `(${parts.join('|')})`

// The flat alternation, or the alternatives factored on a shared leading digit
// ("9(0[1-9]|[1-9].)" beside "(90[1-9]|9[1-9].)"), whichever is shorter.
function shortest(parts) {
  const flat = joined(parts)
  const c = parts[0][0]
  if (parts.length < 2 || !/\d/.test(c) || !parts.every(p => p[0] === c)) return flat
  const factored = `${c}${joined(parts.map(p => p.slice(1)))}`
  return factored.length < flat.length ? factored : flat
}

// A regex matching every integer >= n (and < 1000, the box has no room for more), or '' when
// there is nothing to ask for: n is 0, or round10 takes it to 0 (round10 rounds n down to its
// ten first, which is the "shorter string" lever). Widths above n's own are whole and spelled
// "\d.." (two and three digits together: "\d..?").
export function minRegex(value, round10 = false) {
  const digits = digitsOf(value)
  if (!digits) return ''
  const n0 = Number(digits.join(''))
  const n = round10 ? floor10(n0) : n0
  if (!Number.isFinite(n) || n === 0) return ''
  const s = String(n)
  const w = s.length
  const parts = w > 3 ? span('999', '999', '.') : span(s, '9'.repeat(w), '.')
  if (w === 1) parts.push('\\d..?')
  if (w === 2) parts.push('\\d..')
  return shortest(parts)
}

// The shortest regex for an inclusive integer range. One and two digit bounds only; anything
// wider returns ''. Used for tiers, revives and uses.
export function rangeRegex(min, max, round10 = false) {
  const a = digitsOf(min), b = digitsOf(max)
  if (!a || !b || a.length > 2 || b.length > 2) return ''
  let lo = Number(a.join('')), hi = Number(b.join(''))
  if (round10) { lo = floor10(lo); hi = floor10(hi) }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi > 99 || hi < lo) return ''
  const parts = []
  if (lo <= 9) parts.push(...span(String(lo), String(Math.min(hi, 9)), '.'))
  if (hi >= 10) parts.push(...span(String(Math.max(lo, 10)), String(hi), '.'))
  return joined(parts)
}

const PRICE_MIN = 0
const PRICE_MAX = 999

// The slider's bounds for blank ends; reversed or out-of-range ends are clamped, not refused.
export function normalizePrice(min, max) {
  const lo = String(min ?? '').trim() === '' ? PRICE_MIN : Number(min)
  const hi = String(max ?? '').trim() === '' ? PRICE_MAX : Number(max)
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null
  const clamp = (n) => Math.max(PRICE_MIN, Math.min(PRICE_MAX, n))
  return { min: clamp(Math.min(lo, hi)), max: clamp(Math.max(lo, hi)) }
}

// The shortest spellings of the broad ranges the slider's ends produce.
const BROAD = { '0-9': '\\d', '0-99': '[1-9]?\\d', '1-99': '[1-9]\\d?', '0-999': '(0|[1-9]\\d{0,2})', '1-999': '[1-9]\\d{0,2}' }

// A quoted term matching a price note in the given currency, e.g.
// " ([1-9]|1\d|2[0-5])(\.\d+)? exalted". The leading space anchors on the note ("~b/o 124
// chaos"), otherwise "8 to 123" would also match "124 chaos" through its tail. The optional
// fraction reads "2.5 exalted" by its whole part (notes are often fractional).
export function priceRange(min, max, currency) {
  const r = normalizePrice(min, max)
  if (!r) return ''
  let number = BROAD[`${r.min}-${r.max}`]
  if (!number) {
    const parts = []
    for (let w = 1; w <= 3; w++) {
      const from = Math.max(r.min, w === 1 ? 0 : 10 ** (w - 1)), to = Math.min(r.max, 10 ** w - 1)
      if (from <= to) parts.push(...span(String(from), String(to), '\\d'))
    }
    number = joined(parts)
  }
  return `" ${number}(\\.\\d+)? ${currency}"`
}
