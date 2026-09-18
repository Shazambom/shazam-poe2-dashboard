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

// Value of 1 `id` (with reference price `mid`) in currency `c`, same preference order.
export function valueIn(id, mid, c, prices, pairs) {
  const direct = pairs?.[`${id}>${c}`]
  if (direct > 0) return direct
  return (mid != null && prices?.[c]) ? mid / prices[c] : null
}
