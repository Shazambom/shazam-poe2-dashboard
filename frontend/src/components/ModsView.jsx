import React, { useEffect, useMemo, useRef, useState } from 'react'
import ModsBar from './ModsBar.jsx'
import ModTable from './ModTable.jsx'
import { ModSection, EssenceList, AugmentList } from './ModSection.jsx'
import { useStatus, ensureSettings } from '../lib/statusStore.js'
import { useAutosave } from '../lib/hooks.js'
import { toast } from '../lib/api.js'
import { loadMods, expandedFor, openSectionsFor } from '../lib/mods/index.js'
import { sectionsFor, atLevel, tagsOf, visible, AFFIXES } from '../lib/mods/pool.js'
import { essencesFor, augmentsFor } from '../lib/mods/extras.js'
import { merge } from '../lib/mods/defaults.js'

const TITLES = { prefix: 'Prefix', suffix: 'Suffix', corrupted: 'Corrupted', enchant: 'Upgrade' }

// Trading → Mods: what can roll on an item type between the orb's minimum modifier level and
// the item level, and how likely each family is (docs/mods-page-design.md). The base pool on
// top; the pools other currencies open (bones, socketable uniques, the Genesis Tree, a Vaal
// Orb), the essences and the socketables one level down. Everything is computed locally from
// the shipped tables; the settings live under `mods_tools`.
export default function ModsView() {
  const [s, setS] = useState(null)
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)
  const [filter, setFilter] = useState('')
  const [, bump] = useState(0)
  const { save, arm } = useAutosave(async (next) => { await useStatus.getState().saveSettings({ mods_tools: next }) }, 800)
  useEffect(() => {
    // Saving is armed only once the stored blob is in hand: a failed load shows defaults but
    // must never write them over the user's saved pool.
    ensureSettings().then(x => { setS(merge(x.mods_tools)); arm() }).catch(() => { setS(merge(null)); toast('Could not load your saved settings', false) })
    loadMods().then(setData).catch(() => setFailed(true))
  }, []) // eslint-disable-line

  const def = useMemo(() => data && s && (data.pools.find(p => p.id === s.poolId) || data.pools[0]), [data, s?.poolId])
  const sections = useMemo(() => (def ? sectionsFor(def, data.families) : null), [def, data])
  const levels = useMemo(() => (sections && s ? sections.map(sec => atLevel(sec.pool, s.ilvl, sec.floored ? s.floor : 0)) : null), [sections, s?.ilvl, s?.floor])
  const essences = useMemo(() => (def ? essencesFor(def, data.essences) : []), [def, data])
  const augments = useMemo(() => (def ? augmentsFor(def, data.augments) : []), [def, data])
  const tagOptions = useMemo(() => (sections ? tagsOf(sections[0].pool) : []), [sections])
  const tags = useMemo(() => new Set(s?.tags || []), [s?.tags])
  const shown = useMemo(() => levels && levels.map(level => Object.fromEntries(AFFIXES.filter(a => level[a]).map(a => [a, visible(level[a].rows, { tags, q: filter })]))), [levels, tags, filter])
  const expanded = def ? expandedFor(def.id) : null
  const openSections = def ? openSectionsFor(def.id) : null
  const refs = useRef({})

  if (!s) return null
  const update = (p) => { const n = { ...s, ...p }; setS(n); save(n) }
  const toggle = (id) => { if (expanded.has(id)) expanded.delete(id); else expanded.add(id); bump(x => x + 1) }
  const toggleSection = (id) => { if (openSections.has(id)) openSections.delete(id); else openSections.add(id); bump(x => x + 1) }
  const toggleTag = (id) => update({ tags: tags.has(id) ? s.tags.filter(t => t !== id) : [...s.tags, id] })
  const filtered = tags.size > 0 || filter.trim() !== ''
  const empty = filtered ? 'Clear the filter or a tag to see more.' : 'Nothing rolls here.'
  const ref = (key) => { if (!refs.current[key]) refs.current[key] = React.createRef(); return refs.current[key] }

  const tables = (i) => {
    const level = levels[i], affixes = AFFIXES.filter(a => level[a])
    const hop = (from) => (idx) => { const other = affixes.find(a => a !== from); if (other) refs.current[`${i}:${other}`]?.current?.focus(idx) }
    return (
      <div className={`mods-body ${affixes.length === 1 ? 'one' : ''}`}>
        {affixes.map(a => (
          <ModTable key={a} title={TITLES[a]} rows={shown[i][a]} total={level[a].total} expanded={expanded} onToggle={toggle} focusIndex={ref(`${i}:${a}`)} onHop={hop(a)} empty={empty} />
        ))}
      </div>
    )
  }
  const emptyPool = levels && AFFIXES.every(a => !levels[0][a] || levels[0][a].total === 0)

  return (
    <div className="mods">
      <ModsBar pools={data?.pools || []} poolId={def?.id || s.poolId} ilvl={s.ilvl} floor={s.floor} filter={filter} tags={tags} tagOptions={tagOptions}
               onPool={id => update({ poolId: id, tags: [] })} onIlvl={v => update({ ilvl: v })} onFloor={v => update({ floor: v })}
               onFilter={setFilter} onTag={toggleTag} disabled={!data} />
      {failed && <div className="empty">Reopen the tab to load the modifier tables.</div>}
      {!failed && !shown && <div className="mods-body"><div className="sk mods-skel" /><div className="sk mods-skel" /></div>}
      {shown && emptyPool && <div className="hint mods-hint">Lower the min level or raise the item level to open the pool.</div>}
      {shown && tables(0)}
      {shown && sections.slice(1).map((sec, j) => (
        <ModSection key={sec.id} id={sec.id} title={sec.title} open={openSections.has(sec.id)} onToggle={() => toggleSection(sec.id)}>
          {tables(j + 1)}
        </ModSection>
      ))}
      {shown && essences.some(e => e.kind !== 'alloy') && (
        <ModSection id="essence" title="Essence" open={openSections.has('essence')} onToggle={() => toggleSection('essence')}>
          <EssenceList essences={essences.filter(e => e.kind !== 'alloy')} ilvl={s.ilvl} />
        </ModSection>
      )}
      {shown && essences.some(e => e.kind === 'alloy') && (
        <ModSection id="alloy" title="Alloy" open={openSections.has('alloy')} onToggle={() => toggleSection('alloy')}>
          <EssenceList essences={essences.filter(e => e.kind === 'alloy')} title="Alloy" ilvl={s.ilvl} />
        </ModSection>
      )}
      {shown && augments.length > 0 && (
        <ModSection id="augment" title="Socketables" open={openSections.has('augment')} onToggle={() => toggleSection('augment')}>
          <AugmentList augments={augments} ilvl={s.ilvl} />
        </ModSection>
      )}
    </div>
  )
}
