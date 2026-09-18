import React, { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { api } from '../lib/api.js'
import { useWorkspace } from '../lib/workspaceStore.js'
import { buildPaletteItems } from '../lib/palette.js'
import Cur from './Cur.jsx'

// ⌘K command palette — the fast path. Fuzzy-search across the board's currencies
// (open its detail), the views (jump there), and leagues (switch). Keyboard-first:
// ↑↓ to move, ↵ to run, esc to close. Opened via ⌘K/Ctrl-K or the top-bar chip.
export default function CommandPalette({ open, onClose, tabs, onGoTab, subDests = [], onGoSub, leagues, onSetLeague, onOpenCurrency, commands = [], onOpenSearch }) {
  const tree = useWorkspace(s => s.tree)
  const [q, setQ] = useState('')
  const [rows, setRows] = useState([])   // board currencies (id + name)
  const [sel, setSel] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  useEffect(() => {
    if (!open) return
    setQ(''); setSel(0)
    api.board().then(d => setRows(d?.rows || [])).catch(() => {})
    const t = setTimeout(() => inputRef.current?.focus(), 10)
    return () => clearTimeout(t)
  }, [open])

  const items = useMemo(() => buildPaletteItems({ tabs, subDests, rows, leagues, commands, tree, q }), [tabs, subDests, rows, leagues, commands, tree, q])

  useEffect(() => { if (sel > items.length - 1) setSel(0) }, [items.length, sel])
  // keep the selected row in view as you arrow through
  useEffect(() => {
    const el = listRef.current?.querySelector('.cmdk-item.sel')
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const run = (it) => {
    if (!it) return
    if (it.kind === 'view') onGoTab(it.id)
    else if (it.kind === 'sub') onGoSub?.(it.section, it.sub)
    else if (it.kind === 'league') onSetLeague(it.id)
    else if (it.kind === 'cur') onOpenCurrency(it.id)
    else if (it.kind === 'cmd') it.run?.()
    else if (it.kind === 'ws') onOpenSearch?.(it.id)
    onClose()
  }

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); run(items[sel]) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="cmdk-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <motion.div className="cmdk" onClick={e => e.stopPropagation()}
            initial={{ opacity: 0, y: -14, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}>
            <input ref={inputRef} className="cmdk-input" placeholder="Search currencies, views, leagues…"
              value={q} onChange={e => { setQ(e.target.value); setSel(0) }} onKeyDown={onKey} />
            <div className="cmdk-list" ref={listRef}>
              {items.length === 0 && <div className="cmdk-empty">No matches</div>}
              {items.slice(0, 60).map((it, i) => (
                <div key={it.kind + it.id} className={`cmdk-item ${i === sel ? 'sel' : ''}`}
                  onMouseMove={() => setSel(i)} onClick={() => run(it)}>
                  <span className="cmdk-ic">{it.kind === 'cur' ? <Cur id={it.id} size={16} /> : it.kind === 'league' ? '◆' : it.kind === 'sub' ? '→' : it.kind === 'ws' ? '⌕' : it.kind === 'cmd' ? '⌘' : '↗'}</span>
                  <span className="cmdk-label">{it.label}</span>
                  <span className="cmdk-hint">{it.hint}</span>
                </div>
              ))}
            </div>
            <div className="cmdk-foot"><span><b>↑↓</b> navigate</span><span><b>↵</b> open</span><span><b>esc</b> close</span></div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
