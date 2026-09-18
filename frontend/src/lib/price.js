// Pricing a card in a numeraire. The backend hands us two things: `prices` (reference-currency
// value of every numeraire, from the exchange graph's ref_values) and `pairs` (`"c>n"` → the
// direct c↔n market rate, present only for pairs that actually trade). A card priced in a
// counterpart it trades against directly shows THAT market's rate; only a pair with no market
// of its own falls back to the cross of two reference prices. The cross can be 10–70% off when
// the triangle card/numeraire/reference doesn't close in the hourly digest.
//
// Everything downstream (mid, buy, sell, the sparkline) is `value / factor`, so this returns the
// FACTOR that makes `r.mid / factor` equal the direct rate — the numeraire's reference price as
// implied by the card's own market — and the rest of the card scales consistently with it.
export function factorFor(r, num, prices, pairs) {
  const direct = pairs?.[`${r?.id}>${num}`]
  if (direct > 0 && r?.mid > 0) return r.mid / direct
  return prices?.[num] ?? 1
}

// The card's trend, repriced into `num`. The points arrive in `r.trend_num` (the market the
// price comes from — a card priced by its own Divine market carries Divine points; a reference
// history carries reference points); `factor` is factorFor(r, num). A trend already in `num`
// passes through untouched, so the line ends where the number is.
export function trendIn(r, num, factor, prices, pairs) {
  if (!r?.trend) return r?.trend
  const f = factor || 1
  // No trend_num (a reference-priced series, e.g. the asset modal): reference points, scaled like mid.
  const k = !r.trend_num ? 1 / f : r.trend_num === num ? 1 : factorFor(r, r.trend_num, prices, pairs) / f
  return k === 1 ? r.trend : r.trend.map(p => ({ t: p.t, v: p.v * k }))
}

// Value of 1 `id` (with reference price `mid`) in currency `c`, same preference order.
export function valueIn(id, mid, c, prices, pairs) {
  const direct = pairs?.[`${id}>${c}`]
  if (direct > 0) return direct
  return (mid != null && prices?.[c]) ? mid / prices[c] : null
}
