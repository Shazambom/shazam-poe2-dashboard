import React, { useEffect, useState } from 'react'
import { api } from '../lib/api.js'

const blank = () => ({ id: Math.random().toString(36).slice(2, 10), name: '', kind: 'combine', inputs: { '': 3 }, outputs: { '': 1 }, enabled: true, note: '' })
const one = (obj) => { const [k, v] = Object.entries(obj)[0] ?? ['', 1]; return { id: k, qty: v } }

export default function RecipesView({ currencies }) {
  const [list, setList] = useState([])
  const [saved, setSaved] = useState(false)
  useEffect(() => { api.recipes().then(setList) }, [])
  const opts = currencies?.currencies ?? []

  const upd = (i, patch) => setList(l => l.map((r, j) => j === i ? { ...r, ...patch } : r))
  const setSide = (i, side, field, val) => setList(l => l.map((r, j) => {
    if (j !== i) return r
    const cur = one(r[side])
    const next = field === 'id' ? { [val]: cur.qty } : { [cur.id]: Number(val) }
    return { ...r, [side]: next }
  }))
  const save = async () => { setList(await api.putRecipes(list)); setSaved(true); setTimeout(() => setSaved(false), 1500) }

  return (
    <div className="single">
      <h2>Off-exchange conversions</h2>
      <p className="hint" style={{ maxWidth: 720 }}>
        Disenchant and combine steps cost no gold, so they are used whenever they beat the exchange rate for the same pair.
        A recipe is routable when it has exactly one input and one output; the input must be a whole multiple of the lot size.
        Templates ship disabled — replace the placeholder ids with real ones from the currency list, verify the ratio in game, then enable.
      </p>
      <table>
        <thead><tr><th>On</th><th>Name</th><th>Kind</th><th className="num">Consumes</th><th></th><th className="num">Yields</th><th></th><th>Note</th><th></th></tr></thead>
        <tbody>
          {list.map((r, i) => {
            const inp = one(r.inputs), out = one(r.outputs)
            const known = (id) => opts.some(o => o.id === id)
            return (
              <tr key={r.id}>
                <td><input type="checkbox" checked={!!r.enabled} onChange={e => upd(i, { enabled: e.target.checked })} /></td>
                <td><input className="btn" value={r.name} onChange={e => upd(i, { name: e.target.value })} style={{ width: 240 }} /></td>
                <td><select className="btn" value={r.kind} onChange={e => upd(i, { kind: e.target.value })}>
                  <option value="combine">combine</option><option value="disenchant">disenchant</option><option value="reforge">reforge</option><option value="vendor">vendor</option>
                </select></td>
                <td className="num"><input className="btn" type="number" min="1" value={inp.qty} style={{ width: 70, textAlign: 'right' }} onChange={e => setSide(i, 'inputs', 'qty', e.target.value)} /></td>
                <td><input className="btn" list="cur-ids" value={inp.id} placeholder="trade id" onChange={e => setSide(i, 'inputs', 'id', e.target.value)} style={{ width: 160, borderColor: inp.id && !known(inp.id) ? 'var(--loss)' : undefined }} /></td>
                <td className="num"><input className="btn" type="number" min="1" value={out.qty} style={{ width: 70, textAlign: 'right' }} onChange={e => setSide(i, 'outputs', 'qty', e.target.value)} /></td>
                <td><input className="btn" list="cur-ids" value={out.id} placeholder="trade id" onChange={e => setSide(i, 'outputs', 'id', e.target.value)} style={{ width: 160, borderColor: out.id && !known(out.id) ? 'var(--loss)' : undefined }} /></td>
                <td><input className="btn" value={r.note ?? ''} onChange={e => upd(i, { note: e.target.value })} style={{ width: 220 }} /></td>
                <td><button className="btn small" onClick={() => setList(l => l.filter((_, j) => j !== i))}>Delete</button></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <datalist id="cur-ids">{opts.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</datalist>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={() => setList(l => [...l, blank()])}>Add recipe</button>
        <span className="spacer" />
        <button className="btn primary" onClick={save}>{saved ? 'Saved' : 'Save recipes'}</button>
      </div>
      <p className="hint">A red border means the trade id isn't in the currency list; the recipe will be ignored until it matches.</p>
    </div>
  )
}
