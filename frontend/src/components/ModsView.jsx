import React, { useCallback, useEffect, useMemo, useState } from 'react'
import ModsBar from './ModsBar.jsx'
import ModTable from './ModTable.jsx'
import { ModSection, GrantList, essenceRows, augmentRows } from './ModSection.jsx'
import { useStatus, ensureSettings } from '../lib/statusStore.js'
import { useApi, useAutosave } from '../lib/hooks.js'
import { api, toast } from '../lib/api.js'
import { sessionFor } from '../lib/mods/index.js'
import { prepare, atLevel, visible, AFFIXES } from '../lib/mods/pool.js'
import { merge } from '../lib/mods/defaults.js'
import { familyQuery } from '../lib/mods/trade.js'
import { stashKind, stashMods, withWanted } from '../lib/mods/stash.js'
import { poolFor, matchItem, slotsFor } from '../lib/mods/item.js'
import { merge as mergeRegex } from '../lib/regex/defaults.js'
import { nav } from '../lib/nav.js'
import { useWorkspace } from '../lib/workspaceStore.js'
import waystoneTable from '../data/regex/waystone.json'
import tabletTable from '../data/regex/tablet.json'

const REGEX_TABLES = { waystone: waystoneTable, tablet: tabletTable }

// Desktop only: the trade site's names for a mod and a kind come from main (EE2's data).
const modLookup = typeof window !== 'undefined' ? window.poe2desktop?.trade?.modLookup : null
const modItem = typeof window !== 'undefined' ? window.poe2desktop?.trade?.modItem : null
const PASTE_FAIL = { empty: 'Copy an item in game first', 'not-item': 'The clipboard holds no item', worker: 'Reading items is not available right now' }

const TITLES = { prefix: 'Prefix', suffix: 'Suffix', corrupted: 'Corrupted', enchant: 'Upgrade' }

// Trading → Mods: what can roll on an item type between the orb's minimum modifier level and
// the item level, and how likely each family is (docs/mods-page-design.md). The base pool on
// top; the pools other currencies open, the essences, alloys and socketables one level down.
// The tables come from the local backend (they ride the market seed); the settings live under
// `mods_tools`.
export default function ModsView() {
  const [s, setS] = useState(null)
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState({ rows: new Set(), sections: new Set() })
  const { save, arm } = useAutosave(async (next) => { await useStatus.getState().saveSettings({ mods_tools: next }) }, 800)
  useEffect(() => {
    // Saving is armed only once the stored blob is in hand: a failed load shows defaults but
    // must never write them over the user's saved pool.
    ensureSettings().then(x => { setS(merge(x.mods_tools)); arm() }).catch(() => { setS(merge(null)); toast('Could not load your saved settings', false) })
  }, []) // eslint-disable-line

  const list = useApi(() => api.modPools(), [])
  const pools = list.data?.pools || []
  const currencies = list.data?.currencies || []
  const poolId = s && pools.length ? (pools.find(p => p.id === s.poolId) || pools[0]).id : null
  const fetched = useApi(() => (poolId ? api.modPool(poolId).then(prepare) : Promise.resolve(null)), [poolId])
  const pool = fetched.data && fetched.data.id === poolId ? fetched.data : null
  // What forcing a modifier costs: the pool's grants priced by the local backend (read-only).
  const priced = useApi(() => (poolId ? api.modPrices(poolId).catch(() => null) : Promise.resolve(null)), [poolId])
  const prices = priced.data

  // The pasted item (desktop): its rolled families show their tier and count for nothing, so the
  // chances are over what can still land. Session state, never saved.
  const [item, setItem] = useState(null)
  const match = useMemo(() => matchItem(pool, item), [pool, item])
  const onItem = useMemo(() => (item ? new Map(match.rolled.map(r => [r.family.id, r.tier])) : null), [match, item])
  const levels = useMemo(() => (pool && s ? pool.sections.map(sec => atLevel(sec, s.ilvl, sec.floored ? s.floor : 0, onItem)) : null), [pool, s?.ilvl, s?.floor, onItem])
  const tags = useMemo(() => new Set(s?.tags || []), [s?.tags])
  const shown = useMemo(() => levels && levels.map(level => Object.fromEntries(AFFIXES.filter(a => level[a]).map(a => [a, visible(level[a].rows, { tags, q: filter })]))), [levels, tags, filter])
  const grants = useMemo(() => (pool ? [
    { id: 'essence', title: 'Essence', heading: 'Adds', rows: essenceRows(pool.grants.essences) },
    { id: 'alloy', title: 'Alloy', heading: 'Adds', rows: essenceRows(pool.grants.alloys) },
    { id: 'augment', title: 'Socketables', heading: 'Grants', rows: augmentRows(pool.grants.augments) },
  ].filter(g => g.rows.length) : []), [pool])

  // The session's open rows and sections for this pool, read once per pool and written back
  // on every toggle (a new Set each time, so the memoised rows see the change).
  useEffect(() => { if (poolId) { const st = sessionFor(poolId); setOpen({ rows: new Set(st.rows), sections: new Set(st.sections) }) } }, [poolId])
  const toggleIn = useCallback((kind, id) => setOpen(o => {
    const next = new Set(o[kind]); if (next.has(id)) next.delete(id); else next.add(id)
    if (poolId) sessionFor(poolId)[kind] = next
    return { ...o, [kind]: next }
  }), [poolId])
  const toggleRow = useCallback((id) => toggleIn('rows', id), [toggleIn])
  // Search on trade: the family as a Workspace search for this kind carrying it (docs/mods-page-design.md).
  const onTrade = useCallback(async (affix, id) => {
    const family = pool?.sections.flatMap(sec => sec[affix] || []).find(f => f.id === id)
    const meta = pools.find(p => p.id === poolId)
    if (!family || !meta || !modLookup) return
    let found = null
    try { found = await modLookup({ text: family.text, affix, bases: meta.keywords || [] }) } catch {}
    const built = familyQuery(family, meta, found)
    if (!built) { toast('Search this modifier by hand on the trade site', false); return }
    const ws = useWorkspace.getState()
    const r = ws.ingest({ source: 'mods', q: JSON.stringify(built.query), name: built.name, folder: null })
    if (r.result === 'dropped') { toast('Could not add the search', false); return }
    if (r.result === 'dup' && r.id) ws.rerunFromItem(r.id)
    nav.openTrading('workspace')
  }, [pool, pools, poolId])
  // Find in stash: the family as a wanted modifier of the Regex tab (waystone and tablet pools).
  const stashable = stashKind(pools.find(p => p.id === poolId))
  const onStash = useCallback(async (affix, id) => {
    const family = pool?.sections.flatMap(sec => sec[affix] || []).find(f => f.id === id)
    const kind = stashKind(pools.find(p => p.id === poolId))
    if (!family || !kind) return
    const ids = stashMods(family, REGEX_TABLES[kind])
    if (!ids.length) { toast('Pick this modifier by hand in the Regex tab', false); return }
    try {
      const stored = await ensureSettings()
      await useStatus.getState().saveSettings({ regex_tools: withWanted(mergeRegex(stored.regex_tools), kind, ids) })
    } catch { toast('Could not save the search', false); return }
    nav.openTrading('regex')
  }, [pool, pools, poolId])

  if (!s) return null
  const update = (p) => { const n = { ...s, ...p }; setS(n); save(n) }
  // Paste item: main reads the clipboard and hands over the parse; the pool follows the base.
  const onPaste = async () => {
    let r = null
    try { r = await modItem() } catch { r = { item: null, reason: 'worker' } }
    if (!r?.item) { toast(PASTE_FAIL[r?.reason] || PASTE_FAIL['not-item'], false); return }
    const target = poolFor(pools, r.item)
    if (!target) { toast('No modifier pool for this item type', false); return }
    setItem(r.item)
    update({ poolId: target.id, tags: target.id === poolId ? s.tags : [], ...(r.item.itemLevel ? { ilvl: r.item.itemLevel } : {}) })
  }
  const strip = item ? { name: item.name, base: item.baseType, ilvl: item.itemLevel, count: match.count, slots: slotsFor(item.rarity) } : null
  const toggleTag = (id) => update({ tags: tags.has(id) ? s.tags.filter(t => t !== id) : [...s.tags, id] })
  const empty = tags.size > 0 || filter.trim() !== '' ? 'Clear the filter or a tag to see more.' : 'Nothing rolls here.'
  const failed = list.err || fetched.err
  const loading = !failed && (!list.data || (poolId && !pool))

  const tables = (i, floored) => {
    const level = levels[i], affixes = AFFIXES.filter(a => level[a])
    return (
      <div className={`mods-body ${affixes.length === 1 ? 'one' : ''}`}>
        {affixes.map(a => (
          <ModTable key={a} title={TITLES[a]} affix={a} rows={shown[i][a]} total={level[a].total} expanded={open.rows} onToggle={toggleRow} onTrade={modLookup ? onTrade : null} onStash={stashable ? onStash : null}
                    ilvl={s.ilvl} floor={floored ? s.floor : 0} empty={empty} grants={pool.grants} prices={prices} />
        ))}
      </div>
    )
  }
  const emptyPool = levels && AFFIXES.every(a => !levels[0][a] || levels[0][a].total === 0)

  return (
    <div className="mods">
      <ModsBar pools={pools} currencies={currencies} poolId={poolId || s.poolId} ilvl={s.ilvl} floor={s.floor} filter={filter} tags={tags} tagOptions={pool?.tags || []}
               onPool={id => update({ poolId: id, tags: [] })} onIlvl={v => update({ ilvl: v })} onFloor={v => update({ floor: v })}
               onFilter={setFilter} onTag={toggleTag} disabled={!list.data}
               item={strip} onPaste={modItem ? onPaste : null} onClearItem={() => setItem(null)} />
      {failed && <div className="empty">Reopen the tab to load the modifier tables.</div>}
      {!failed && list.data && !pools.length && <div className="empty">The modifier tables arrive with the next market update.</div>}
      {loading && pools.length > 0 && <div className="mods-body"><div className="sk mods-skel" /><div className="sk mods-skel" /></div>}
      {shown && emptyPool && <div className="hint mods-hint">Lower the min level or raise the item level to open the pool.</div>}
      {shown && tables(0, true)}
      {shown && pool.sections.slice(1).map((sec, j) => (
        <ModSection key={sec.id} id={sec.id} title={sec.title} open={open.sections.has(sec.id)} onToggle={() => toggleIn('sections', sec.id)}>
          {tables(j + 1, sec.floored)}
        </ModSection>
      ))}
      {shown && grants.map(g => (
        <ModSection key={g.id} id={g.id} title={g.title} open={open.sections.has(g.id)} onToggle={() => toggleIn('sections', g.id)}>
          <GrantList title={g.title} heading={g.heading} rows={g.rows} ilvl={s.ilvl} prices={prices} />
        </ModSection>
      ))}
    </div>
  )
}
