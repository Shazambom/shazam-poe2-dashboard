import React from 'react'
import { tagLabel } from '../lib/mods/pool.js'

const pct = (x) => (x === null || x === 0 ? '–' : `${(x * 100).toFixed(1)}%`)
const lines = (text) => text.split('\n').map((l, i) => <React.Fragment key={i}>{i > 0 && <br />}{l}</React.Fragment>)

// One family row and, when open, its tiers in three bands: above the item level, in the pool,
// below the min level. Values re-render inside the same nodes on every level change, so focus
// and scroll survive; the row is keyed by the family id by its table.
function ModFamily({ row, open, onToggle, tabIndex, onKeyDown, rowRef, perTier }) {
  const { family, k, n, chance, tiers } = row
  const out = k === 0
  return (
    <div className="mods-fam-wrap">
      <div ref={rowRef} className={`mods-fam ${out ? 'out' : ''}`} role="button" aria-expanded={open} tabIndex={tabIndex}
           onClick={onToggle} onKeyDown={onKeyDown}>
        <span className="mods-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="mods-text">{lines(family.text)}</span>
        <span className="mods-fam-tags">{family.tags.slice(0, 2).map(tagLabel).join(' · ')}</span>
        <span className="mods-num">{k} / {n}</span>
        <span className="mods-num mods-chance">{pct(chance)}</span>
      </div>
      {open && (
        <div className="mods-tiers" role="region" aria-label={family.text}>
          {perTier !== null && <div className="mods-tiers-head">Each tier {pct(perTier)}</div>}
          {tiers.map((t, i) => (
            <div key={t.id} className={`mods-tier ${t.state} ${i > 0 && tiers[i - 1].state !== t.state ? 'cut' : ''}`}>
              <span className="mods-num">T{t.tier}</span>
              <span className="mods-tier-name">{t.name}</span>
              <span className="mods-num">{t.ilvl}</span>
              <span className="mods-text">{lines(t.text)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default React.memo(ModFamily)
