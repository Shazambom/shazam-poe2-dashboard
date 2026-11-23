// Pricing a card in a numeraire. The backend hands us ONE table: `prices`, the reference-currency
// value of every currency (Graph.values — each priced through its deepest markets). A price in any
// numeraire is the ratio of two of them, so nothing on a card can contradict anything else on it.
//
// Everything downstream (mid, buy, sell, the sparkline) is `value / factor`, so the factor is
// simply the numeraire's own value.
export function factorFor(r, num, prices) {
  return prices?.[num] ?? 1
}

// The card's trend, repriced into `num`. The points arrive in `r.trend_num` (the market the
// price comes from — a card priced by its own Divine market carries Divine points; a reference
// history carries reference points); `factor` is factorFor(r, num). A trend already in `num`
// passes through untouched, so the line ends where the number is.
export function trendIn(r, num, factor, prices) {
  if (!r?.trend) return r?.trend
  const f = factor || 1
  // No trend_num (a reference-priced series, e.g. the asset modal): reference points, scaled like mid.
  const k = !r.trend_num ? 1 / f : r.trend_num === num ? 1 : (prices?.[r.trend_num] ?? 1) / f
  return k === 1 ? r.trend : r.trend.map(p => ({ t: p.t, v: p.v * k }))
}

// Value of 1 `id` (with reference price `mid`) in currency `c` — the same ratio, one table.
export function valueIn(id, mid, c, prices) {
  return (mid != null && prices?.[c]) ? mid / prices[c] : null
}

// Convert `amount` of currency `from` into currency `to` using a single price table (`prices`,
// any common unit). Same currency passes through untouched; missing or non-positive rates return null.
export function exchange(amount, from, to, prices) {
  const a = Number(amount)
  if (!Number.isFinite(a) || !from || !to) return null
  if (from === to) return a
  const mid = prices?.[from]
  if (!(mid > 0)) return null
  const rate = valueIn(from, mid, to, prices)
  return rate != null && rate > 0 ? a * rate : null
}

// Build an injectable `(amount, from, to) => converted | null` exchange function over `prices`,
// falling back to `fallbackPrices` (e.g. status.wealth_prices) or bridging through a shared divine anchor.
export function makeExchange(prices, fallbackPrices = null) {
  return (amount, from, to) => {
    const a = Number(amount)
    if (!Number.isFinite(a) || !from || !to) return null
    if (from === to) return a
    const direct = exchange(a, from, to, prices)
    if (direct != null) return direct
    if (!fallbackPrices) return null
    const fb = exchange(a, from, to, fallbackPrices)
    if (fb != null) return fb
    if (prices?.divine > 0 && fallbackPrices?.divine > 0) {
      const inDiv = exchange(a, from, 'divine', prices) ?? exchange(a, from, 'divine', fallbackPrices)
      if (inDiv != null) {
        return exchange(inDiv, 'divine', to, prices) ?? exchange(inDiv, 'divine', to, fallbackPrices)
      }
    }
    return null
  }
}

// The readable side (owner, 2026-10-08: "follow the volume rule and then apply readable side to the volume
// rule"). The backend names the market; a rate below 1 in it is drawn from the other side — 0.093 Divine per
// Chaos is "10.7 per Divine". `n` is the number to draw; `per` says it is the counterpart's side.
export function readable(rate) {
  if (rate == null || !(rate > 0) || rate >= 1) return { n: rate, per: false }
  return { n: 1 / rate, per: true }
}

// The % change of the other side of a market: +25% one way is exactly -20% the other.
export function flipChange(pct) {
  return pct == null ? null : -pct / (1 + pct / 100)
}
