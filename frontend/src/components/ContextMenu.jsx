import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'

// A right-click menu anchored at a point. `items`: [{ label, key?, run?, children?, disabled?, sep? }] —
// `children` opens a submenu on hover/→. Closes on Escape, outside click, scroll, or after a run.
// Keyboard: ↑↓ move, → open submenu, ← back, Enter run. Pure DOM positioning (kept on-screen).
export default function ContextMenu({ at, items, onClose }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(at)
  const [sel, setSel] = useState(-1)
  const [sub, setSub] = useState(null)   // index of the item whose submenu is open
  const [subSel, setSubSel] = useState(-1)

  useLayoutEffect(() => {
    const el = ref.current; if (!el) return
    const r = el.getBoundingClientRect()
    setPos({ x: Math.min(at.x, window.innerWidth - r.width - 8), y: Math.min(at.y, window.innerHeight - r.height - 8) })
  }, [at])

  useEffect(() => {
    const down = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    window.addEventListener('mousedown', down, true); window.addEventListener('keydown', esc, true)
    window.addEventListener('scroll', onClose, true); window.addEventListener('blur', onClose)
    ref.current?.focus()
    return () => { window.removeEventListener('mousedown', down, true); window.removeEventListener('keydown', esc, true); window.removeEventListener('scroll', onClose, true); window.removeEventListener('blur', onClose) }
  }, [onClose])

  const live = items.filter(i => !i.sep)
  const run = (it) => { if (!it || it.disabled) return; if (it.children) { setSub(items.indexOf(it)); setSubSel(0); return } it.run?.(); onClose() }
  const onKey = (e) => {
    const list = sub != null ? items[sub].children : live
    const cur = sub != null ? subSel : sel
    const setCur = sub != null ? setSubSel : setSel
    if (e.key === 'ArrowDown') { e.preventDefault(); setCur(Math.min(cur + 1, list.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCur(Math.max(cur - 1, 0)) }
    else if (e.key === 'ArrowRight' && sub == null && live[sel]?.children) { e.preventDefault(); setSub(items.indexOf(live[sel])); setSubSel(0) }
    else if (e.key === 'ArrowLeft' && sub != null) { e.preventDefault(); setSub(null) }
    else if (e.key === 'Enter') { e.preventDefault(); if (sub != null) { items[sub].children[subSel]?.run?.(); onClose() } else run(live[sel]) }
  }

  return (
    <div className="ctx-menu" role="menu" tabIndex={-1} ref={ref} style={{ left: pos.x, top: pos.y }} onKeyDown={onKey} onContextMenu={e => e.preventDefault()}>
      {items.map((it, i) => it.sep
        ? <div key={i} className="ctx-sep" role="separator" />
        : (
          <div key={i} role="menuitem" aria-disabled={it.disabled || undefined} aria-haspopup={it.children ? 'menu' : undefined}
            className={`ctx-item ${live.indexOf(it) === sel ? 'sel' : ''} ${it.disabled ? 'disabled' : ''} ${it.danger ? 'danger' : ''}`}
            onMouseEnter={() => { setSel(live.indexOf(it)); setSub(it.children ? i : null) }}
            onClick={e => { e.stopPropagation(); run(it) }}>
            <span className="ctx-label">{it.label}</span>
            {it.key && <span className="ctx-key">{it.key}</span>}
            {it.children && <span className="ctx-more">▸</span>}
            {it.children && sub === i && (
              <div className="ctx-menu ctx-sub" role="menu">
                {it.children.length === 0 && <div className="ctx-item disabled">No groups yet</div>}
                {it.children.map((c, j) => (
                  <div key={j} role="menuitem" className={`ctx-item ${j === subSel ? 'sel' : ''} ${c.disabled ? 'disabled' : ''}`}
                    onMouseEnter={() => setSubSel(j)} onClick={e => { e.stopPropagation(); if (!c.disabled) { c.run?.(); onClose() } }}>
                    <span className="ctx-label">{c.label}</span>
                  </div>))}
              </div>)}
          </div>))}
    </div>
  )
}
