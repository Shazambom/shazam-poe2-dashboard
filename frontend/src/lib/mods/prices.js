// Prices beside mods (docs/mods-page-design.md): what forcing a modifier costs. A grant row
// (an essence's or alloy's forced mod) prints exactly one tier's text of the family it forces,
// so the link is the text; the server prices the pool's grants from the app's one value table,
// keyed by grant name (`GET /api/mods/pool/{id}/prices`). Pure.

// The grants that force a tier of the family: { name, tier, level }, best tier first.
export function forcedBy(family, grants) {
  const tiers = new Map((family?.tiers || []).map(t => [t.text, t.tier]))
  const out = []
  for (const kind of ['essences', 'alloys']) {
    for (const g of grants?.[kind] || []) {
      for (const r of g.rows || []) {
        const tier = tiers.get(r.text)
        if (tier !== undefined) out.push({ name: g.name, tier, level: r.level })
      }
    }
  }
  return out.sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name))
}

// The price of a grant in the reference, or null when the exchange does not trade it.
export const priceOf = (name, prices) => (prices?.prices && prices.prices[name] != null ? prices.prices[name] : null)
