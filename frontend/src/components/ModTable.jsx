import React from 'react'
import ModFamily from './ModFamily.jsx'
import { shownChance } from '../lib/mods/pool.js'
import { pct } from '../lib/mods/format.jsx'

// One affix column: header, the family rows that pass the filter, the total. Rows are buttons in
// native tab order; one delegated handler on the list toggles them (Enter, Space, Esc to close).
function ModTable({ title, affix, rows, total, expanded, onToggle, onTrade, ilvl, floor, empty }) {
  const idOf = (e) => e.target.closest('.mods-fam')?.dataset.id
  const onClick = (e) => {
    const trade = e.target.closest('[data-trade]')
    if (trade) { onTrade(affix, trade.dataset.trade); return }
    const id = idOf(e); if (id) onToggle(id)
  }
  const onKeyDown = (e) => {
    const id = idOf(e)
    if (!id) return
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(id) }
    else if (e.key === 'Escape' && expanded.has(id)) { e.preventDefault(); onToggle(id) }
  }
  return (
    <section className="mods-table rx-surface">
      <div className="mods-head">
        <span className="settings-sub">{title}</span>
        <span className="mods-num">Tiers</span>
        <span className="mods-num">Chance</span>
      </div>
      <div className="mods-rows" onClick={onClick} onKeyDown={onKeyDown}>
        {rows.map(r => <ModFamily key={r.family.id} row={r} open={expanded.has(r.family.id)} ilvl={ilvl} floor={floor} perTier={total ? 1 / total : null} canTrade={!!onTrade} />)}
        {!rows.length && <div className="empty small">{empty}</div>}
      </div>
      <div className="mods-total">
        <span>Total</span>
        <span className="mods-num">{total}</span>
        <span className="mods-num mods-chance">{pct(shownChance(rows))}</span>
      </div>
    </section>
  )
}

export default React.memo(ModTable)
