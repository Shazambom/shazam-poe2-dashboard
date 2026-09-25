import React, { useState } from 'react'
import CurrencyPicker from './CurrencyPicker.jsx'
import Cur from './Cur.jsx'
import Num from './Num.jsx'
import { currencyFor, floorOf, orbOptions } from '../lib/mods/orbs.js'

const ANY = { id: 'any', name: 'Any orb' }
const orbIcon = (o, size) => (o.id === 'any' ? null : <Cur name={o.name} size={size} />)

// The sticky bar: which pool, the pool's two edges (item level, min modifier level), the orb
// that sets the floor, the text filter, and the pool's own tags as chips. On the desktop, the
// copied item: paste it, and the bar says what it is and how many affixes it holds of its slots.
export default function ModsBar({ pools, currencies, poolId, ilvl, floor, filter, tags, tagOptions, onPool, onIlvl, onFloor, onFilter, onTag, disabled, item, onPaste, onClearItem }) {
  // The floor is the one stored value; the picker reads it back as the orb last picked while the
  // number still matches it, else the first orb with that floor, else Any.
  const [picked, setPicked] = useState(null)
  const orbs = [ANY, ...orbOptions(currencies)]
  const orb = (picked && floorOf(currencies, picked) === floor ? picked : currencyFor(currencies, floor)?.id) || 'any'
  const pickOrb = (id) => { setPicked(id); onFloor(floorOf(currencies, id)) }
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
          <CurrencyPicker value={orb} onChange={pickOrb} options={orbs} placeholder="Search orbs" renderIcon={orbIcon} />
        </div>
        <div className="field mods-filter">
          <label>Filter</label>
          <input className="ws-filter-input" value={filter} onChange={e => onFilter(e.target.value)} placeholder="Filter modifiers" spellCheck={false} />
        </div>
        {onPaste && (
          <div className="field mods-paste">
            <label>Item</label>
            <button type="button" className="btn small" onClick={onPaste}>Paste item</button>
          </div>
        )}
      </div>
      {item && (
        <div className="mods-item" role="status">
          <span className="mods-item-name">{item.name ? `${item.name} · ${item.base}` : item.base}</span>
          <span className="mods-num">ilvl {item.ilvl ?? '–'}</span>
          {item.slots && <span className="mods-num">Prefix {item.count.prefix} / {item.slots.prefix} · Suffix {item.count.suffix} / {item.slots.suffix}</span>}
          <button type="button" className="btn small" onClick={onClearItem}>Clear</button>
        </div>
      )}
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
