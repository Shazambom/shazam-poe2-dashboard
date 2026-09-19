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
