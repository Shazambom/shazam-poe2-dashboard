import React, { useEffect, useMemo, useRef, useState } from 'react'
import Cur from './Cur.jsx'

const defaultIcon = (o, size) => <Cur id={o.id} name={o.name} size={size} />

// Searchable currency combobox: shows the selected currency's icon + name; on focus it turns
// into a type-ahead that progressively filters, listing matches as icons + names (reuses the
// ⌘K palette's list styling so it matches the app aesthetic). Keyboard: ↑↓ move, ↵ pick, esc close.
// `renderIcon(option)` swaps the per-row icon (default: the currency icon); pass `null` for none.
// An option's `keywords` (hidden aliases, e.g. the base names behind a mod pool) match the query too.
export default function CurrencyPicker({ value, onChange, options = [], placeholder = 'search…', renderIcon = defaultIcon }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const boxRef = useRef(null)
  const inputRef = useRef(null)

  const selected = useMemo(() => options.find(o => o.id === value), [options, value])
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return options
    // A hit on the name or id outranks a hidden keyword hit ("ruby" is the Ruby jewel before the Ruby Charm).
    const direct = options.filter(o => o.name.toLowerCase().includes(t) || String(o.id).toLowerCase().includes(t))
    const viaKeyword = options.filter(o => !direct.includes(o) && o.keywords?.some(k => k.toLowerCase().includes(t)))
    return [...direct, ...viaKeyword]
  }, [options, q])

  // close on outside click
  useEffect(() => {
    const h = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) { setOpen(false); setQ('') } }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  useEffect(() => { if (sel > matches.length - 1) setSel(0) }, [matches.length, sel])

  const choose = (o) => { if (o) { onChange(o.id); setOpen(false); setQ('') } }
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setSel(s => Math.min(s + 1, matches.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(matches[sel]) }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setQ('') }
  }

  return (
    <div className="curpick" ref={boxRef}>
      <div className={`curpick-box ${open ? 'open' : ''}`} onClick={() => { setOpen(true); inputRef.current?.focus() }}>
        {selected && !open && renderIcon && renderIcon(selected, 18)}
        <input ref={inputRef} className="curpick-input"
          value={open ? q : (selected?.name ?? '')}
          placeholder={placeholder}
          onFocus={() => { setOpen(true); setSel(0) }}
          onChange={e => { setQ(e.target.value); setSel(0); setOpen(true) }}
          onKeyDown={onKey} />
      </div>
      {open && (
        <div className="curpick-pop">
          {matches.length === 0 && <div className="cmdk-empty">No matches</div>}
          {matches.slice(0, 80).map((o, i) => (
            <div key={o.id} className={`cmdk-item ${i === sel ? 'sel' : ''}`}
              onMouseMove={() => setSel(i)} onMouseDown={e => { e.preventDefault(); choose(o) }}>
              {renderIcon && <span className="cmdk-ic">{renderIcon(o, 16)}</span>}
              <span className="cmdk-label">{o.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
