import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { opensUp, room } from '../lib/dropdown.js'
import Cur from './Cur.jsx'
import { norm, search } from '../lib/search.js'

const defaultIcon = (o, size) => <Cur id={o.id} name={o.name} size={size} />
const CREATE = '\u0000create'   // the "Add “…”" row's id: never a real option's

// Searchable currency combobox: shows the selected currency's icon + name; on focus it turns
// into a type-ahead that progressively filters, listing matches as icons + names (reuses the
// ⌘K palette's list styling so it matches the app aesthetic). Keyboard: ↑↓ move, ↵ pick, esc close.
// `renderIcon(option)` swaps the per-row icon (default: the currency icon); pass `null` for none.
// Matching is lib/search.js: every typed word, any order, typos forgiven when nothing else matches. An option's
// `keywords` (hidden aliases, e.g. the base names behind a mod pool) and its exact trade id match too.
// `onCreate(text)`, when given, offers a typed name that matches no option as a new entry ("Add “…”");
// `known` (a Set of lowercased names) lists names that exist even when not offered, so they are never "added".
// `onClear`, when given: the user typed over a pick (it is dropped until they choose again).
export default function CurrencyPicker({ value, onChange, options = [], placeholder = 'search…', renderIcon = defaultIcon, onCreate = null, known = null, onClear = null }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [up, setUp] = useState(false)   // open the list upward when it would be cut off below
  const boxRef = useRef(null)
  const inputRef = useRef(null)

  const selected = useMemo(() => options.find(o => o.id === value), [options, value])
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return options
    const found = search(options, q, o => [[o.name], o.keywords, o.id])
    const exact = found.some(o => norm(o.name) === norm(q)) || !!known?.has(t)
    return onCreate && !exact ? [...found, { id: CREATE, name: `Add “${q.trim()}”`, create: q.trim() }] : found   // a known item always comes first
  }, [options, q, onCreate, known])

  // close on outside click
  useEffect(() => {
    const h = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) { setOpen(false); setQ('') } }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])
  useEffect(() => { if (sel > matches.length - 1) setSel(0) }, [matches.length, sel])
  // keep the highlighted row in view as you arrow through
  useEffect(() => {
    if (open) boxRef.current?.querySelector('.cmdk-item.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel, open])
  useLayoutEffect(() => {
    const pop = boxRef.current?.querySelector('.curpick-pop')
    if (!open || !pop) return
    // the room a list needs is its own max height (styles.css .curpick-pop)
    setUp(opensUp({ ...room(boxRef.current.querySelector('.curpick-box')), need: parseFloat(getComputedStyle(pop).maxHeight) || pop.offsetHeight }))
  }, [open])

  const choose = (o) => {
    if (!o) return
    if (o.create) onCreate(o.create)
    else onChange(o.id)
    setOpen(false); setQ('')
  }
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setSel(s => Math.min(s + 1, matches.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (open) choose(matches[sel]) }   // closed: a pick already made stays
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
          onChange={e => { setQ(e.target.value); setSel(0); setOpen(true); if (value) onClear?.() }}   // typing replaces the pick
          onKeyDown={onKey} />
      </div>
      {open && (
        <div className={`curpick-pop ${up ? 'up' : ''}`}>
          {matches.length === 0 && <div className="cmdk-empty">No matches</div>}
          {matches.slice(0, 80).map((o, i) => (
            <div key={o.id} className={`cmdk-item ${i === sel ? 'sel' : ''}`}
              onMouseMove={() => setSel(i)} onMouseDown={e => { e.preventDefault(); choose(o) }}>
              {renderIcon && !o.create && <span className="cmdk-ic">{renderIcon(o, 16)}</span>}
              <span className="cmdk-label">{o.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
