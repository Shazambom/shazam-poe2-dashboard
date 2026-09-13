import React, { useEffect, useState } from 'react'
import { api, fmt } from '../lib/api.js'

const PRIMARY = ['chaos', 'exalted', 'divine']

export default function CapitalView({ currencies, onSaved }) {
  const [rows, setRows] = useState({})
  const [data, setData] = useState(null)
  const [add, setAdd] = useState('')
  const [saved, setSaved] = useState(false)

  const load = () => api.capital().then(d => {
    setData(d)
    const r = Object.fromEntries(PRIMARY.map(p => [p, 0]))
    d.rows.forEach(x => { r[x.currency] = x.qty })
    setRows(r)
  })
  useEffect(() => { load() }, [])

  const names = Object.fromEntries((currencies?.currencies ?? []).map(c => [c.id, c.name]))
  const save = async () => {
    await api.putCapital(rows); await load(); onSaved?.(); setSaved(true); setTimeout(() => setSaved(false), 1500)
  }
  const valueOf = (c) => data?.rows.find(r => r.currency === c)

  return (
    <div className="single">
      <div className="two-col">
        <div>
          <h2>What you hold</h2>
          <p className="hint">Enter counts from your stash. Routes are sized from these numbers, capped by the fraction set in Settings. Chaos, Exalted and Divine are always listed.</p>
          <table>
            <thead><tr><th>Currency</th><th className="num">Quantity</th><th className="num">Each, in {data?.reference}</th><th className="num">Value</th><th></th></tr></thead>
            <tbody>
              {Object.keys(rows).map(c => {
                const v = valueOf(c)
                return (
                  <tr key={c}>
                    <td>{names[c] ?? c}</td>
                    <td className="num"><input type="number" min="0" step="1" value={rows[c]} style={{ width: 110, textAlign: 'right' }} className="btn"
                      onChange={e => setRows(r => ({ ...r, [c]: e.target.value }))} /></td>
                    <td className="num muted">{v?.ref_value != null ? fmt.rate(v.ref_value) : 'no quote'}</td>
                    <td className="num">{v?.value_ref != null ? fmt.n(v.value_ref, 1) : '–'}</td>
                    <td>{!PRIMARY.includes(c) && <button className="btn small" onClick={() => setRows(r => { const n = { ...r }; delete n[c]; return n })}>Remove</button>}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            <select className="btn" value={add} onChange={e => setAdd(e.target.value)}>
              <option value="">Add another currency</option>
              {(currencies?.currencies ?? []).filter(c => !(c.id in rows)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="btn" disabled={!add} onClick={() => { setRows(r => ({ ...r, [add]: 0 })); setAdd('') }}>Add</button>
            <span className="spacer" />
            <button className="btn primary" onClick={save}>{saved ? 'Saved' : 'Save capital'}</button>
          </div>
        </div>
        <div>
          <h2>Total</h2>
          <p style={{ fontSize: 28, margin: '4px 0 0', fontWeight: 600 }}>{fmt.n(data?.total_ref, 1)} <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>{data?.reference}</span></p>
          <p className="hint">Valued at the best current quote into the reference currency. Currencies without a quote are listed but not counted.</p>
        </div>
      </div>
    </div>
  )
}
