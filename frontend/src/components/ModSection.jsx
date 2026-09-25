import React from 'react'
import Cur from './Cur.jsx'
import { lines } from '../lib/mods/format.jsx'

// A pool another currency opens on the item, one level down from the base tables: a header
// that opens it, and inside whatever the section holds (tables or a grant list).
export function ModSection({ id, title, open, onToggle, children }) {
  return (
    <section className={`mods-section ${open ? 'open' : ''}`}>
      <button type="button" className="sales-head mods-sec-head" aria-expanded={open} aria-controls={`mods-sec-${id}`} onClick={onToggle}>
        <span className="mods-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="mods-sec-title">{title}</span>
      </button>
      {open && <div id={`mods-sec-${id}`} className="mods-sec-body">{children}</div>}
    </section>
  )
}

// A list of things that grant a fixed modifier rather than roll one: an essence's forced mod,
// a socketable's effect. Row: { key, name, badge, lines: [{ text, cls }], level }. A level above
// the item level is muted: that grant cannot land on this item.
export function GrantList({ title, heading, rows, ilvl }) {
  return (
    <div className="mods-list rx-surface">
      <div className="mods-head mods-grant"><span className="settings-sub">{title}</span><span>{heading}</span><span className="mods-num">Level</span></div>
      {rows.map(r => (
        <div key={r.key} className={`mods-grant ${r.level > ilvl ? 'out' : ''}`}>
          <span className="mods-grant-name"><Cur name={r.name} size={16} /> {r.name} {r.badge && <span className="mods-fam-tags">{r.badge}</span>}</span>
          <span className="mods-text">{r.lines.map((l, i) => <div key={i} className={l.cls || ''}>{lines(l.text)}</div>)}</span>
          <span className="mods-num">{r.level || '–'}</span>
        </div>
      ))}
    </div>
  )
}

const AFFIX = { prefix: 'Prefix', suffix: 'Suffix', implicit: 'Implicit' }

// Essence rows: one per class row (an essence may force one mod per affix).
export const essenceRows = (essences) => essences.flatMap(e => e.rows.map((r, i) => ({ key: `${e.name}:${i}`, name: e.name, badge: AFFIX[r.affix] || r.affix, lines: [{ text: r.text }], level: r.level })))

// Socketable rows: the effect, then the bonded effect.
export const augmentRows = (augments) => augments.map(a => ({ key: a.id, name: a.name, badge: a.type, level: a.level, lines: [...a.fits[0].text.map(text => ({ text })), ...a.fits[0].bonded.map(text => ({ text, cls: 'mods-bonded' }))] }))
