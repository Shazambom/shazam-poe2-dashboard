import React, { useEffect, useMemo, useRef, useState } from 'react'
import Toggle from './Toggle.jsx'
import Seg from './Seg.jsx'
import ModPicker from './ModPicker.jsx'
import RegexResult from './RegexResult.jsx'
import { useStatus, ensureSettings } from '../lib/statusStore.js'
import { useAutosave } from '../lib/hooks.js'
import { toast, copyText } from '../lib/api.js'
import { nav } from '../lib/nav.js'
import { useWorkspace } from '../lib/workspaceStore.js'
import { generate, query, merge, defaults } from '../lib/regex/index.js'
import waystoneTable from '../data/regex/waystone.json'
import tabletTable from '../data/regex/tablet.json'

// Trading → Regex: the in-game search-string builder (docs/regex-filters-plan.md). Pick a kind,
// set what to match, copy the string. Everything is computed locally from the shipped tables;
// the settings live in the user's settings blob under `regex_tools`.
const TABLES = { waystone: waystoneTable, tablet: tabletTable }
const KIND_OPTIONS = [['waystone', 'Waystones'], ['tablet', 'Tablets']]
const RARITIES = [['normal', 'Normal'], ['magic', 'Magic'], ['rare', 'Rare']]
const YIELDS = [['itemRarity', 'Item rarity'], ['packSize', 'Pack size'], ['monsterRarity', 'Monster rarity'], ['monsterEffect', 'Monster effectiveness'], ['dropChance', 'Waystone drop chance']]
const CURRENCIES = [['exalted', 'Exalted'], ['divine', 'Divine']]
const MODES = [['any', 'Any'], ['all', 'All']]

// Exact numbers here, not sliders (owner, 2026-09-24): people are precise about the mods they
// want. Each box is clamped to its range; blank means "any" where 0 does.
function Num({ label, value, min, max, onChange, placeholder }) {
  const clamp = (raw) => { if (raw === '') return min; const n = Math.floor(Number(raw)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min }
  return (
    <div className="field rx-num">
      <label>{label}</label>
      <input type="number" inputMode="numeric" min={min} max={max} step="1" value={value === 0 && placeholder ? '' : value} placeholder={placeholder}
             onChange={e => onChange(clamp(e.target.value))} onFocus={e => e.target.select()} />
    </div>
  )
}

export default function RegexView() {
  const [s, setS] = useState(null)
  const { save, arm } = useAutosave(async (next) => { await useStatus.getState().saveSettings({ regex_tools: next }) }, 800)
  useEffect(() => {
    // Saving is armed only once the stored blob is in hand: a failed load shows defaults but
    // must never write them over the user's saved selections.
    ensureSettings().then(x => { setS(merge(x.regex_tools)); arm() }).catch(() => { setS(merge(null)); toast('Could not load your saved settings', false) })
  }, []) // eslint-disable-line

  const kind = s?.kind || 'waystone'
  const cfg = s?.[kind]
  const table = TABLES[kind]
  const text = useMemo(() => (cfg ? generate(kind, cfg, table) : ''), [kind, cfg, table])
  const want = useMemo(() => new Map((cfg?.want || []).map(w => [w.id, w.min])), [cfg?.want])
  const avoid = useMemo(() => new Set(cfg?.avoid || []), [cfg?.avoid])

  // Copy on every change, but never on arrival: a clipboard write the user did not cause.
  const seen = useRef(null)
  useEffect(() => {
    if (!s) return
    if (seen.current === null) { seen.current = text; return }
    if (text !== seen.current) { seen.current = text; if (s.autoCopy && text) copyText(text, 'Regex', true) }
  }, [text, s]) // eslint-disable-line

  if (!s) return null

  const update = (fn) => { const n = fn(s); setS(n); save(n) }
  const patch = (p) => update(x => ({ ...x, [kind]: { ...x[kind], ...p } }))
  const sub = (key, p) => patch({ [key]: { ...cfg[key], ...p } })
  // A from/to pair: the moved end drags the other along, both stay inside [lo, hi], and the
  // range's other fields (a price's currency and toggles) stay put.
  const range = (key, side, v, lo, hi) => {
    const r = { ...cfg[key], [side]: v }
    if (side === 'min' && r.max < v) r.max = v
    if (side === 'max' && r.min > v) r.min = v
    patch({ [key]: { ...r, min: Math.max(lo, r.min), max: Math.min(hi, r.max) } })
  }
  const toggleWant = (id) => patch({ want: want.has(id) ? cfg.want.filter(w => w.id !== id) : [...cfg.want, { id, min: 0 }] })
  const setMin = (id, min) => patch({ want: cfg.want.map(w => (w.id === id ? { ...w, min } : w)) })
  const toggleAvoid = (id) => patch({ avoid: avoid.has(id) ? cfg.avoid.filter(x => x !== id) : [...cfg.avoid, id] })

  const onTrade = () => {
    const ws = useWorkspace.getState()
    const r = ws.ingest({ source: 'regex', q: JSON.stringify(query(kind, cfg, table)), name: `${kind === 'waystone' ? 'Waystone' : 'Tablet'} search`, folder: null })
    if (r.result === 'dropped') { toast('Could not add the search', false); return }
    // The same query again: re-run it rather than remount the slug the site gave the old row
    // (a slug carries the league it was made in).
    if (r.result === 'dup' && r.id) ws.rerunFromItem(r.id)
    nav.openTrading('workspace')
  }

  const modeSeg = <Seg value={cfg.wantMode} options={MODES} onChange={v => patch({ wantMode: v })} />
  const price = (
    <details className="adv rx-section">
      <summary>Price</summary>
      <div className="rx-pair">
        <Num label="From" value={cfg.price.min} min={0} max={999} onChange={v => range('price', 'min', v, 0, 999)} />
        <Num label="To" value={cfg.price.max} min={0} max={999} onChange={v => range('price', 'max', v, 0, 999)} />
      </div>
      <div className="rx-toggles">
        <Seg value={cfg.price.currency} options={CURRENCIES} onChange={v => sub('price', { currency: v })} />
        <Toggle checked={cfg.price.on} onChange={v => sub('price', { on: v })} label="In the string" />
        <Toggle checked={cfg.price.trade} onChange={v => sub('price', { trade: v })} label="In the trade search" />
      </div>
    </details>
  )
  const rarity = (
    <section className="rx-section">
      <div className="settings-sub">Rarity</div>
      <div className="rx-toggles">
        {RARITIES.map(([k, label]) => <Toggle key={k} checked={cfg.rarity[k]} onChange={v => sub('rarity', { [k]: v })} label={label} />)}
      </div>
    </section>
  )
  const round = <Toggle checked={cfg.round10} onChange={v => patch({ round10: v })} label="Round to tens" />

  return (
    <div className="regex">
      <RegexResult lead={<Seg value={kind} options={KIND_OPTIONS} onChange={k => update(x => ({ ...x, kind: k }))} />}
                   text={text} onCopy={() => copyText(text, 'Regex')} onReset={() => patch(structuredClone(defaults[kind]))} onTrade={onTrade}
                   autoCopy={s.autoCopy} onAutoCopy={v => update(x => ({ ...x, autoCopy: v }))}
                   append={cfg.append} onAppend={v => patch({ append: v })} />
      <div className="rx-body">
        <div className="rx-side rx-surface">
          {kind === 'waystone' ? (
            <>
              <section className="rx-section">
                <div className="settings-sub">Tier</div>
                <div className="rx-pair">
                  <Num label="From" value={cfg.tier.min} min={1} max={16} onChange={v => range('tier', 'min', v, 1, 16)} />
                  <Num label="To" value={cfg.tier.max} min={1} max={16} onChange={v => range('tier', 'max', v, 1, 16)} />
                </div>
              </section>
              <section className="rx-section">
                <div className="settings-sub">Revives</div>
                <div className="rx-pair">
                  <Num label="From" value={cfg.revives.min} min={0} max={6} onChange={v => range('revives', 'min', v, 0, 6)} />
                  <Num label="To" value={cfg.revives.max} min={0} max={6} onChange={v => range('revives', 'max', v, 0, 6)} />
                </div>
              </section>
              {rarity}
              <section className="rx-section">
                <div className="settings-sub">State</div>
                <div className="rx-toggles grid">
                  <Toggle checked={cfg.state.corrupted} onChange={v => sub('state', { corrupted: v })} label="Corrupted" />
                  <Toggle checked={cfg.state.uncorrupted} onChange={v => sub('state', { uncorrupted: v })} label="Uncorrupted" />
                  <Toggle checked={cfg.state.delirious} onChange={v => sub('state', { delirious: v })} label="Delirious" />
                  {round}
                </div>
              </section>
              <section className="rx-section">
                <div className="settings-sub">Yield, at least %</div>
                <div className="rx-pair">
                  {YIELDS.map(([k, label]) => <Num key={k} label={label} value={cfg[k]} min={0} max={999} placeholder="any" onChange={v => patch({ [k]: v })} />)}
                </div>
              </section>
            </>
          ) : (
            <>
              <section className="rx-section">
                <div className="settings-sub">Type</div>
                <div className="rx-toggles grid">
                  {table.kinds.map(k => <Toggle key={k.key} checked={!!cfg.type[k.key]} onChange={v => sub('type', { [k.key]: v })} label={k.label} />)}
                </div>
              </section>
              {rarity}
              <section className="rx-section">
                <div className="settings-sub">Uses remaining, at least</div>
                <Num label="Uses" value={cfg.uses} min={0} max={18} placeholder="any" onChange={v => patch({ uses: v })} />
                <div className="rx-toggles">{round}</div>
              </section>
            </>
          )}
          {price}
        </div>
        <div className="rx-pickers">
          <ModPicker mods={table.mods} selected={want} hide={avoid} onToggle={toggleWant} onMin={setMin} header="Include">{modeSeg}</ModPicker>
          {kind === 'waystone' && <ModPicker mods={table.mods} selected={avoid} hide={want} onToggle={toggleAvoid} header="Exclude" />}
        </div>
      </div>
    </div>
  )
}
