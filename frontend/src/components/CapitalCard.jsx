import React, { useEffect, useRef, useState } from 'react'
import { api, fmt, surface } from '../lib/api.js'

const PRIMARY = ['chaos', 'exalted', 'divine']

// What-you-hold editor that lives in the Routes rail. Quantities auto-save
// (debounced) — no Save button, no separate page.
export default function CapitalCard({ currencies, status, onSaved }) {
  const [qty, setQty] = useState(null)          // { currency: "string qty" } as typed
  const [data, setData] = useState(null)        // last server valuation
  const [add, setAdd] = useState('')
  const [state, setState] = useState('')        // '', 'saving', 'saved'
  const timer = useRef(null)
  const names = Object.fromEntries((currencies?.currencies ?? []).map(c => [c.id, c.name]))

  useEffect(() => {
    api.capital().then(d => {
      setData(d)
      const r = Object.fromEntries(PRIMARY.map(p => [p, 0]))
      d.rows.forEach(x => { r[x.currency] = x.qty })
      setQty(r)
    }).catch(() => setQty(Object.fromEntries(PRIMARY.map(p => [p, 0]))))
    return () => clearTimeout(timer.current)
  }, [])

  const persist = (rows) => {
    clearTimeout(timer.current)
    setState('saving')
    timer.current = setTimeout(async () => {
      const entries = {}
      Object.entries(rows).forEach(([c, v]) => { const n = Number(v); if (Number.isFinite(n) && n > 0) entries[c] = n })
      try {
        const d = await surface(api.putCapital(entries))
        setData(d); setState('saved'); onSaved?.()
        setTimeout(() => setState(s => s === 'saved' ? '' : s), 1500)
      } catch { setState('') }
    }, 700)
  }
  const setOne = (c, v) => setQty(r => { const n = { ...r, [c]: v }; persist(n); return n })
  const remove = (c) => setQty(r => { const n = { ...r }; delete n[c]; persist(n); return n })
  const valueOf = (c) => data?.rows.find(r => r.currency === c)
  const backfilling = status?.digest?.backfilling
  const ref = data?.reference ?? 'exalted'

  if (!qty) return <div className="hint">Loading capital…</div>
  return (
    <div className="capcard">
      <h2>What you hold <span className="save-state">{state === 'saving' ? 'saving…' : state === 'saved' ? 'saved ✓' : ''}</span></h2>
      <table className="capital-table">
        <tbody>
          {Object.keys(qty).map(c => {
            const v = valueOf(c)
            return (
              <tr key={c}>
                <td title={c}>{names[c] ?? c}</td>
                <td className="num"><input type="number" min="0" step="1" value={qty[c]}
                  onChange={e => setOne(c, e.target.value)} /></td>
                <td className="num muted" title={v?.ref_value != null ? `1 ${c} ≈ ${fmt.rate(v.ref_value)} ${ref}` : ''}>
                  {v?.value_ref != null ? `${fmt.n(v.value_ref, 1)} ${ref}`
                    : Number(qty[c]) > 0 ? <span title={backfilling ? 'valued once market data finishes syncing' : 'no market rate yet'}>…</span> : ''}
                </td>
                <td>{!PRIMARY.includes(c) && <button className="btn small" title="Remove" onClick={() => remove(c)}>×</button>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 6 }}>
        <input className="btn" list="cap-add" placeholder="Add currency…" value={add}
          onChange={e => setAdd(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && names[add] && !(add in qty)) { setQty(r => ({ ...r, [add]: 0 })); setAdd('') } }}
          style={{ flex: 1, minWidth: 0 }} />
        <button className="btn small" disabled={!names[add] || add in qty}
          onClick={() => { setQty(r => ({ ...r, [add]: 0 })); setAdd('') }}>Add</button>
        <datalist id="cap-add">
          {(currencies?.currencies ?? []).filter(c => !(c.id in qty)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </datalist>
      </div>
      <p className="hint" style={{ marginTop: 6 }}>Total <b>{fmt.n(data?.total_ref, 1)} {ref}</b> · loops are sized from these counts.</p>
    </div>
  )
}
