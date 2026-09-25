import React, { useState } from 'react'
import CurrencyPicker from './CurrencyPicker.jsx'
import Cur from './Cur.jsx'
import Num from './Num.jsx'
import { CURRENCIES, currencyFor, floorOf } from '../lib/mods/currency.js'

const ANY = { id: 'any', name: 'Any orb' }
const ORBS = [ANY, ...CURRENCIES]
const orbIcon = (o, size) => (o.id === 'any' ? null : <Cur name={o.name} size={size} />)

// The sticky bar: which pool, the pool's two edges (item level, min modifier level), the orb
// that sets the floor, the text filter, and the pool's own tags as chips.
export default function ModsBar({ pools, poolId, ilvl, floor, filter, tags, tagOptions, onPool, onIlvl, onFloor, onFilter, onTag, disabled }) {
  // The floor is the one stored value; the picker reads it back as the orb last picked while the
  // number still matches it, else the first orb with that floor, else Any.
  const [picked, setPicked] = useState(null)
  const orb = (picked && floorOf(picked) === floor ? picked : currencyFor(floor)?.id) || 'any'
  const pickOrb = (id) => { setPicked(id); onFloor(floorOf(id)) }
  return (
    <div className="mods-bar rx-surface">
      <div className="mods-controls">
        <div className="field mods-pool">
          <label>Item type</label>
          <CurrencyPicker value={poolId} onChange={onPool} options={pools} placeholder={disabled ? 'Loading…' : 'Search item types'} renderIcon={null} />
        </div>
        <Num label="Item level" value={ilvl} min={1} max={100} onChange={onIlvl} />
        <Num label="Min level" value={floor} min={0} max={100} placeholder="any" onChange={onFloor} />
        <div className="field mods-orb">
          <label>Orb</label>
          <CurrencyPicker value={orb} onChange={pickOrb} options={ORBS} placeholder="Search orbs" renderIcon={orbIcon} />
        </div>
        <div className="field mods-filter">
          <label>Filter</label>
          <input className="ws-filter-input" value={filter} onChange={e => onFilter(e.target.value)} placeholder="Filter modifiers" spellCheck={false} />
        </div>
      </div>
      {tagOptions.length > 0 && (
        <div className="mods-tags" role="group" aria-label="Tags">
          {tagOptions.map(t => (
            <button key={t.id} type="button" className={`mods-tag ${tags.has(t.id) ? 'on' : ''}`} aria-pressed={tags.has(t.id)} onClick={() => onTag(t.id)}>{t.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}
