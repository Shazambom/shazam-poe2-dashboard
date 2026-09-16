import React from 'react'
import { motion } from 'motion/react'

// The one sub-tab strip (Strategy / Economy / Trading). `layoutId` must be unique per section or
// the underline animates across sections.
export default function SubTabs({ subs, value, onChange, layoutId }) {
  return (
    <nav className="subtabs" role="tablist">
      {subs.map(s => (
        <button key={s.id} role="tab" aria-selected={value === s.id} onClick={() => onChange(s.id)}>
          {s.label}
          {value === s.id && <motion.span className="subtab-underline" layoutId={layoutId}
            transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
        </button>
      ))}
    </nav>
  )
}
