import React, { useMemo, useState } from 'react'

// A filterable list of modifiers; click a row to pick it. Picked rows sit at the top so the
// selection is always in view, but the order only changes when the filter changes or the
// pointer leaves the list, never under the cursor. `hide` (a Set of ids) drops the other list's
// picks. A picked mod whose table row offers a minimum (`num`) gets a small minimum box at the
// row's end (blank = any roll). `selected` is a Map or Set of ids (a Map carries the minimums).
// Rows show the mod's text with # where the roll goes, as the tooltip does.
function ModPicker({ mods, selected, hide, onToggle, onMin, header, children }) {
  const [filter, setFilter] = useState('')
  const [settled, setSettled] = useState(0)
  const q = filter.trim().toLowerCase()
  const shown = useMemo(() => {
    const pool = mods.filter(m => !(hide?.has(m.id) && !selected.has(m.id)))
    const matching = q ? pool.filter(m => m.text.toLowerCase().includes(q)) : pool
    return [...matching.filter(m => selected.has(m.id)), ...matching.filter(m => !selected.has(m.id))]
  }, [mods, hide, q, settled]) // eslint-disable-line react-hooks/exhaustive-deps
  const minOf = (id) => (selected instanceof Map ? selected.get(id) : 0) || ''
  return (
    <div className="rx-picker rx-surface">
      <div className="rx-head"><span className="settings-sub">{header}</span>{children}</div>
      <input className="ws-filter-input" value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter modifiers" spellCheck={false} />
      <div className="rx-list" role="listbox" aria-multiselectable="true" aria-label={header} onMouseLeave={() => setSettled(n => n + 1)}>
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
