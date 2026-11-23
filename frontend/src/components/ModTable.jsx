import React from 'react'
import ModFamily from './ModFamily.jsx'
import { shownChance } from '../lib/mods/pool.js'
import { pct } from '../lib/mods/format.jsx'

// One affix column: header, the family rows that pass the filter, the total. Each family row handles its own keyboard input.
function ModTable({ title, affix, rows, total, expanded, onToggle, onTrade, onStash, ilvl, floor, empty, grants, prices }) {
  return (
    <section className="mods-table rx-surface">
      <div className="mods-head">
        <span className="settings-sub">{title}</span>
        <span className="mods-num">Tiers</span>
        <span className="mods-num">Chance</span>
      </div>
      <div className="mods-rows" role="group" aria-label={title}>
        {rows.map(r => <ModFamily key={r.family.id} row={r} open={expanded.has(r.family.id)} ilvl={ilvl} floor={floor} perTier={total ? 1 / total : null} affix={affix} onToggle={onToggle} onTrade={onTrade} onStash={onStash} grants={grants} prices={prices} />)}
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
