import React, { useRef } from 'react'
import ModFamily from './ModFamily.jsx'
import { shownChance } from '../lib/mods/pool.js'

const pct = (x) => (x === null ? '–' : `${(x * 100).toFixed(1)}%`)

// One affix column: header, the family rows that pass the filter, the total. Rows are a roving
// tabindex list (↑/↓, Home/End, Enter/Space, Esc); ←/→ hand focus to the other column.
export default function ModTable({ title, rows, total, expanded, onToggle, onHop, focusIndex, empty }) {
  const refs = useRef([])
  const focus = (i) => refs.current[Math.max(0, Math.min(rows.length - 1, i))]?.focus()
  const onKey = (i, id) => (e) => {
    const k = e.key
    if (k === 'ArrowDown') { e.preventDefault(); focus(i + 1) }
    else if (k === 'ArrowUp') { e.preventDefault(); focus(i - 1) }
    else if (k === 'Home') { e.preventDefault(); focus(0) }
    else if (k === 'End') { e.preventDefault(); focus(rows.length - 1) }
    else if (k === 'Enter' || k === ' ') { e.preventDefault(); onToggle(id) }
    else if (k === 'Escape') { if (expanded.has(id)) { e.preventDefault(); onToggle(id) } }
    else if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); onHop(i) }
  }
  React.useImperativeHandle(focusIndex, () => ({ focus }), [rows.length])
  const perTier = total ? 1 / total : null
  return (
    <section className="mods-table rx-surface">
      <div className="mods-head">
        <span className="settings-sub">{title}</span>
        <span className="mods-num">Tiers</span>
        <span className="mods-num">Chance</span>
      </div>
      <div className="mods-rows">
        {rows.map((r, i) => (
          <ModFamily key={r.family.id} row={r} open={expanded.has(r.family.id)} onToggle={() => onToggle(r.family.id)}
                     tabIndex={i === 0 ? 0 : -1} onKeyDown={onKey(i, r.family.id)} rowRef={el => { refs.current[i] = el }} perTier={perTier} />
        ))}
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
