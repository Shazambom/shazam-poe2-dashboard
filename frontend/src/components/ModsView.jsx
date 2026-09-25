import React, { useCallback, useEffect, useMemo, useState } from 'react'
import ModsBar from './ModsBar.jsx'
import ModTable from './ModTable.jsx'
import { ModSection, GrantList, essenceRows, augmentRows } from './ModSection.jsx'
import { useStatus, ensureSettings } from '../lib/statusStore.js'
import { useAutosave } from '../lib/hooks.js'
import { toast } from '../lib/api.js'
import { loadMods, sessionFor } from '../lib/mods/index.js'
import { sectionsFor, atLevel, tagsOf, visible, AFFIXES } from '../lib/mods/pool.js'
import { essencesFor, augmentsFor } from '../lib/mods/extras.js'
import { merge } from '../lib/mods/defaults.js'

const TITLES = { prefix: 'Prefix', suffix: 'Suffix', corrupted: 'Corrupted', enchant: 'Upgrade' }

// Trading → Mods: what can roll on an item type between the orb's minimum modifier level and
// the item level, and how likely each family is (docs/mods-page-design.md). The base pool on
// top; the pools other currencies open, the essences, alloys and socketables one level down.
// Everything is computed locally from the shipped tables; the settings live under `mods_tools`.
export default function ModsView() {
  const [s, setS] = useState(null)
  const [data, setData] = useState(null)
  const [failed, setFailed] = useState(false)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState({ rows: new Set(), sections: new Set() })
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
  const tagOptions = useMemo(() => (sections ? tagsOf(sections[0].pool) : []), [sections])
  const tags = useMemo(() => new Set(s?.tags || []), [s?.tags])
  const shown = useMemo(() => levels && levels.map(level => Object.fromEntries(AFFIXES.filter(a => level[a]).map(a => [a, visible(level[a].rows, { tags, q: filter })]))), [levels, tags, filter])
  const grants = useMemo(() => {
    if (!def) return []
    const ess = essencesFor(def, data.essences)
    return [
      { id: 'essence', title: 'Essence', heading: 'Adds', rows: essenceRows(ess.filter(e => e.kind !== 'alloy')) },
      { id: 'alloy', title: 'Alloy', heading: 'Adds', rows: essenceRows(ess.filter(e => e.kind === 'alloy')) },
      { id: 'augment', title: 'Socketables', heading: 'Grants', rows: augmentRows(augmentsFor(def, data.augments)) },
    ].filter(g => g.rows.length)
  }, [def, data])

  // The session's open rows and sections for this pool, read once per pool and written back
  // on every toggle (a new Set each time, so the memoised rows see the change).
  useEffect(() => { if (def) { const st = sessionFor(def.id); setOpen({ rows: new Set(st.rows), sections: new Set(st.sections) }) } }, [def])
  const toggleIn = useCallback((kind, id) => setOpen(o => {
    const next = new Set(o[kind]); if (next.has(id)) next.delete(id); else next.add(id)
    if (def) sessionFor(def.id)[kind] = next
    return { ...o, [kind]: next }
  }), [def])
  const toggleRow = useCallback((id) => toggleIn('rows', id), [toggleIn])

  if (!s) return null
  const update = (p) => { const n = { ...s, ...p }; setS(n); save(n) }
  const toggleTag = (id) => update({ tags: tags.has(id) ? s.tags.filter(t => t !== id) : [...s.tags, id] })
  const empty = tags.size > 0 || filter.trim() !== '' ? 'Clear the filter or a tag to see more.' : 'Nothing rolls here.'

  const tables = (i, floored) => {
    const level = levels[i], affixes = AFFIXES.filter(a => level[a])
    return (
      <div className={`mods-body ${affixes.length === 1 ? 'one' : ''}`}>
        {affixes.map(a => (
          <ModTable key={a} title={TITLES[a]} rows={shown[i][a]} total={level[a].total} expanded={open.rows} onToggle={toggleRow}
                    ilvl={s.ilvl} floor={floored ? s.floor : 0} empty={empty} />
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
      {shown && tables(0, true)}
      {shown && sections.slice(1).map((sec, j) => (
        <ModSection key={sec.id} id={sec.id} title={sec.title} open={open.sections.has(sec.id)} onToggle={() => toggleIn('sections', sec.id)}>
          {tables(j + 1, sec.floored)}
        </ModSection>
      ))}
      {shown && grants.map(g => (
        <ModSection key={g.id} id={g.id} title={g.title} open={open.sections.has(g.id)} onToggle={() => toggleIn('sections', g.id)}>
          <GrantList title={g.title} heading={g.heading} rows={g.rows} ilvl={s.ilvl} />
        </ModSection>
      ))}
    </div>
  )
}
