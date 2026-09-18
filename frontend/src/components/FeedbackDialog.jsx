import React, { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'

// "Report a problem" (desktop only). Opening it packages the report at once — the app's state, logs
// and a picture of every screen, sealed so only the developer can read it — then shows ONE file chip
// the user drags into the Discord #bug-reports forum. The Discord post is the message; nothing is
// typed here. The note says only what to do with the file (owner's call): no description of what
// is inside, no sizes, no screen counts, nothing about what was captured.
export default function FeedbackDialog({ onClose }) {
  const fb = window.poe2desktop?.feedback
  const [st, setSt] = useState({ phase: 'packaging' })   // packaging | ready | error
  useEffect(() => {
    let live = true
    fb?.package().then(r => {
      if (!live) return
      if (!r || r.error) setSt({ phase: 'error', message: r?.error || 'could not package a report' })
      else setSt({ phase: 'ready', shortId: r.shortId })
    }).catch(e => live && setSt({ phase: 'error', message: String(e?.message || e) }))
    return () => { live = false }
  }, []) // eslint-disable-line
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onClose])
  // Focus moves into the dialog on open and back to whatever opened it on close.
  const closeRef = useRef(null)
  useEffect(() => {
    const opener = document.activeElement
    closeRef.current?.focus()
    return () => { try { opener?.focus?.() } catch {} }
  }, [])
  const name = st.shortId ? `arbiter-report-${st.shortId}` : null
  return (
    <motion.div className="detail-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
      <motion.div className="card-detail fb-dialog" role="dialog" aria-modal="true" aria-label="Report a problem"
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.18, ease: [0.22, 0.61, 0.36, 1] }} onClick={e => e.stopPropagation()}>
        <button ref={closeRef} className="cd-close" onClick={onClose} title="Close (Esc)">×</button>
        <div className="cd-head"><span className="cd-title">Report a problem</span></div>
        {st.phase === 'packaging' && <p className="fb-note muted"><i className="spin" /> Packaging a report…</p>}
        {st.phase === 'error' && <p className="fb-note muted">Couldn't package a report ({st.message}).</p>}
        {st.phase === 'ready' && (
          <>
            <div className="fb-chip" draggable title="Drag into Discord"
              onDragStart={e => { e.preventDefault(); fb.drag(st.shortId) }}>
              <span className="fb-grip" aria-hidden="true">⠿</span>{name}
            </div>
            <p className="fb-note muted">Drag this into <b>#bug-reports</b> on Discord and write up what you're experiencing.</p>
            <div className="fb-actions">
              <button className="btn small primary" onClick={() => fb.discord()}>Open Discord</button>
              <button className="btn small" onClick={() => fb.reveal(st.shortId)}>Show file</button>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  )
}
