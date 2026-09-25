import React from 'react'
import Cur from './Cur.jsx'

const lines = (text) => text.split('\n').map((l, i) => <React.Fragment key={i}>{i > 0 && <br />}{l}</React.Fragment>)

// A pool another currency opens on the item, one level down from the base tables: a header
// that opens it, and inside whatever the section holds (tables, an essence list, a socketable list).
export function ModSection({ id, title, open, onToggle, children }) {
  return (
    <section className={`mods-section ${open ? 'open' : ''}`}>
      <button type="button" className="mods-sec-head" aria-expanded={open} aria-controls={`mods-sec-${id}`} onClick={onToggle}>
        <span className="mods-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="mods-sec-title">{title}</span>
      </button>
      {open && <div id={`mods-sec-${id}`} className="mods-sec-body">{children}</div>}
    </section>
  )
}

const AFFIX = { prefix: 'Prefix', suffix: 'Suffix', implicit: 'Implicit' }

// What each essence forces on this item type: the essence, the modifier, its affix and level.
// A level above the item level is muted: that essence's modifier cannot land on this item.
export function EssenceList({ essences, ilvl }) {
  return (
    <div className="mods-list rx-surface">
      <div className="mods-head mods-ess-head"><span className="settings-sub">Essence</span><span>Adds</span><span className="mods-num">Level</span></div>
      {essences.map(e => e.rows.map((r, i) => (
        <div key={`${e.name}:${i}`} className={`mods-ess ${r.level > ilvl ? 'out' : ''}`}>
          <span className="mods-ess-name"><Cur name={e.name} size={16} /> {e.name}</span>
          <span className="mods-text">{lines(r.text)} <span className="mods-fam-tags">{AFFIX[r.affix] || r.affix}</span></span>
          <span className="mods-num">{r.level || '–'}</span>
        </div>
      )))}
    </div>
  )
}

// What each rune, soul core and idol grants when socketed in this item type.
export function AugmentList({ augments, ilvl }) {
  return (
    <div className="mods-list rx-surface">
      <div className="mods-head mods-aug-head"><span className="settings-sub">Socketable</span><span>Grants</span><span className="mods-num">Level</span></div>
      {augments.map(a => (
        <div key={a.id} className={`mods-aug ${a.level && a.level > ilvl ? 'out' : ''}`}>
          <span className="mods-ess-name"><Cur name={a.name} size={16} /> {a.name} <span className="mods-fam-tags">{a.type}</span></span>
          <span className="mods-text">
            {a.fits[0].text.map((t, i) => <div key={`t${i}`}>{lines(t)}</div>)}
            {a.fits[0].bonded.map((t, i) => <div key={`b${i}`} className="mods-bonded">{lines(t)}</div>)}
          </span>
          <span className="mods-num">{a.level || '–'}</span>
        </div>
      ))}
    </div>
  )
}
