import React from 'react'
import { tagLabel, bandOf, namedTiers } from '../lib/mods/pool.js'
import { forcedBy, priceOf } from '../lib/mods/prices.js'
import { pct, lines } from '../lib/mods/format.jsx'
import { Price } from './ModSection.jsx'
import Cur from './Cur.jsx'

// One family row and, when open, its tiers in three bands: above the item level, in the pool,
// below the min level. The row carries its family id for the table's delegated click and key
// handlers, so no callback is allocated per row and the memo holds across filter keystrokes.
// The name column goes when no tier has one (a corruption implicit and its upgrade). Under the
// tiers, what forces one (an essence, an alloy) and what it costs.
function ModFamily({ row, open, ilvl, floor, perTier, canTrade, canStash, grants, prices }) {
  const { family, k, n, chance } = row
  const named = open && namedTiers(family)
  const forced = open ? forcedBy(family, grants) : []
  const on = row.onItem !== undefined   // the pasted item carries this family (its tier, when known)
  return (
    <div className="mods-fam-wrap">
      <div className={`mods-fam ${k === 0 ? 'out' : ''} ${on ? 'on-item' : ''}`} role="button" aria-expanded={open} tabIndex={0} data-id={family.id}>
        <span className="mods-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="mods-text">{lines(family.text)}</span>
        <span className="mods-fam-tags">{family.tags.slice(0, 2).map(tagLabel).join(' · ')}</span>
        <span className="mods-num">{on ? (row.onItem ? `T${row.onItem}` : 'on item') : `${k} / ${n}`}</span>
        <span className="mods-num mods-chance">{on ? '–' : pct(chance)}</span>
      </div>
      {open && (
        <div className={`mods-tiers ${named ? '' : 'unnamed'}`} role="region" aria-label={family.text}>
          <div className="mods-tiers-head">
            <span>{perTier !== null && <>Each tier {pct(perTier)}</>}</span>
            <span className="mods-tiers-actions">
              {canStash && <button type="button" className="btn small" data-stash={family.id}>Find in stash</button>}
              {canTrade && <button type="button" className="btn small" data-trade={family.id}>Search on trade</button>}
            </span>
          </div>
          {family.tiers.map((t, i) => {
            const band = bandOf(t, ilvl, floor)
            return (
              <div key={t.id} className={`mods-tier ${band} ${i > 0 && bandOf(family.tiers[i - 1], ilvl, floor) !== band ? 'cut' : ''}`}>
                <span className="mods-num">T{t.tier}</span>
                {named && <span className="mods-tier-name">{t.name}</span>}
                <span className="mods-num">{t.ilvl}</span>
                <span className="mods-text">{lines(t.text)}</span>
              </div>
            )
          })}
          {forced.map(f => (
            <div key={f.name} className={`mods-forced ${f.level > ilvl ? 'out' : ''}`}>
              <span className="mods-num">T{f.tier}</span>
              <span className="mods-grant-name"><Cur name={f.name} size={14} /> {f.name}</span>
              <Price value={priceOf(f.name, prices)} reference={prices?.reference} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default React.memo(ModFamily)
