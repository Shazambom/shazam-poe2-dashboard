import React, { useMemo, useState } from 'react'
import { matching, norm } from '../lib/search.js'

// A filterable list of modifiers; click a row to pick it. Picked rows sit at the top so the
// selection is always in view, but the order only changes when the filter changes or the
// pointer leaves the list, never under the cursor. `hide` (a Set of ids) drops the other list's
// picks. A picked mod whose table row offers a minimum (`num`) gets a small minimum box at the
// row's end (blank = any roll). `selected` is a Map or Set of ids (a Map carries the minimums).
// Rows show the mod's text with # where the roll goes, as the tooltip does.
function ModPicker({ mods, selected, hide, onToggle, onMin, header, children, cmd }) {
  const [filter, setFilter] = useState('')
  const filterKey = norm(filter)
  // Snapshot the selection used to rank the list. Toggling a row updates its
  // controls immediately, while its position stays put until the pointer leaves.
  const snapshot = () => ({ mods, hide, selected, filter, filterKey })
  const [order, setOrder] = useState(snapshot)
  if (order.mods !== mods || order.hide !== hide || order.filterKey !== filterKey) setOrder(snapshot())
  const shown = useMemo(() => {
    const pool = order.mods.filter(m => !(order.hide?.has(m.id) && !order.selected.has(m.id)))
    const kept = matching(pool, order.filter, m => [m.text])
    return [...kept.filter(m => order.selected.has(m.id)), ...kept.filter(m => !order.selected.has(m.id))]
  }, [order])
  const minOf = (id) => (selected instanceof Map ? selected.get(id) : 0) || ''
  return (
    <div className="rx-picker rx-surface">
      <div className="rx-head"><span className="settings-sub">{header}</span>{children}</div>
      <input className="ws-filter-input" data-cmd={cmd} value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter modifiers" spellCheck={false} />
      <div className="rx-list" role="listbox" tabIndex={-1} aria-multiselectable="true" aria-label={header} onMouseLeave={() => setOrder(snapshot())}>
        {shown.map(m => {
          const on = selected.has(m.id)
          return (
            <div key={m.id} className={`rx-row ${on ? 'on' : ''}`} role="option" aria-selected={on} tabIndex={0}
                 onClick={() => onToggle(m.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(m.id) } }}>
              <span className="rx-text">{m.text}</span>
              {on && onMin && m.num && (
                <input className="rx-min" type="number" inputMode="numeric" min="0" max="99" placeholder="min" value={minOf(m.id)}
                       onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}
                       onChange={e => onMin(m.id, Math.max(0, Math.min(99, Math.floor(Number(e.target.value) || 0))))} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default React.memo(ModPicker)
