import React, { useEffect, useRef, useState } from 'react'
import { api, surface } from '../lib/api.js'
import Cur from './Cur.jsx'
import Toggle from './Toggle.jsx'

const blank = () => ({ id: Math.random().toString(36).slice(2, 10), name: '', kind: 'combine', inputs: { '': 3 }, outputs: { '': 1 }, enabled: true, note: '' })
const one = (obj) => { const [k, v] = Object.entries(obj)[0] ?? ['', 1]; return { id: k, qty: v } }

// Auto-saves (debounced); usable standalone or embedded inside Settings.
export default function RecipesView({ currencies, embedded = false }) {
  const [list, setList] = useState(null)
  const [state, setState] = useState('')
  const timer = useRef(null)
  const loaded = useRef(false)
  useEffect(() => {
    api.recipes().then(l => { setList(l); setTimeout(() => { loaded.current = true }, 0) })
    return () => clearTimeout(timer.current)
  }, [])
  const opts = currencies?.currencies ?? []

  const persist = (next) => {
    if (!loaded.current) return
    clearTimeout(timer.current)
    setState('saving')
    timer.current = setTimeout(async () => {
      try {
        setList(await surface(api.putRecipes(next)))
        setState('saved'); setTimeout(() => setState(x => x === 'saved' ? '' : x), 1500)
      } catch { setState('') }
    }, 800)
  }
  const change = (fn) => setList(l => { const n = fn(l); persist(n); return n })
  const upd = (i, patch) => change(l => l.map((r, j) => j === i ? { ...r, ...patch } : r))
  const setSide = (i, side, field, val) => change(l => l.map((r, j) => {
    if (j !== i) return r
    const cur = one(r[side])
    const next = field === 'id' ? { [val]: cur.qty } : { [cur.id]: Number(val) }
    return { ...r, [side]: next }
  }))

  if (!list) return <p className="hint">Loading recipes…</p>
  const body = (
    <>
      <p className="hint" style={{ maxWidth: 720 }}>
        Disenchant and combine steps cost no gold, so they are used whenever they beat the exchange rate for the same pair.
        Templates ship disabled — replace placeholder ids with real ones, verify the ratio in game, then enable.
        <span className="save-state"> {state === 'saving' ? 'saving…' : state === 'saved' ? 'saved ✓' : ''}</span>
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead><tr><th>On</th><th>Name</th><th>Kind</th><th className="num">Consumes</th><th></th><th className="num">Yields</th><th></th><th></th></tr></thead>
          <tbody>
            {list.map((r, i) => {
              const inp = one(r.inputs), out = one(r.outputs)
              const known = (id) => opts.some(o => o.id === id)
              return (
                <tr key={r.id}>
                  <td><Toggle checked={!!r.enabled} onChange={v => upd(i, { enabled: v })} title="Enable this recipe" /></td>
                  <td><input className="btn" value={r.name} onChange={e => upd(i, { name: e.target.value })} style={{ width: 180 }} /></td>
                  <td><select className="btn" value={r.kind} onChange={e => upd(i, { kind: e.target.value })}>
                    <option value="combine">combine</option><option value="disenchant">disenchant</option><option value="reforge">reforge</option><option value="vendor">vendor</option>
                  </select></td>
                  <td className="num"><input className="btn" type="number" min="1" value={inp.qty} style={{ width: 64, textAlign: 'right' }} onChange={e => setSide(i, 'inputs', 'qty', e.target.value)} /></td>
                  <td><span className="row" style={{ gap: 6 }}>{inp.id && known(inp.id) && <Cur id={inp.id} size={18} />}<input className="btn" list="cur-ids" value={inp.id} placeholder="trade id" onChange={e => setSide(i, 'inputs', 'id', e.target.value)} style={{ width: 140, borderColor: inp.id && !known(inp.id) ? 'var(--loss)' : undefined }} /></span></td>
                  <td className="num"><input className="btn" type="number" min="1" value={out.qty} style={{ width: 64, textAlign: 'right' }} onChange={e => setSide(i, 'outputs', 'qty', e.target.value)} /></td>
                  <td><span className="row" style={{ gap: 6 }}>{out.id && known(out.id) && <Cur id={out.id} size={18} />}<input className="btn" list="cur-ids" value={out.id} placeholder="trade id" onChange={e => setSide(i, 'outputs', 'id', e.target.value)} style={{ width: 140, borderColor: out.id && !known(out.id) ? 'var(--loss)' : undefined }} /></span></td>
                  <td><button className="btn small" onClick={() => change(l => l.filter((_, j) => j !== i))}>×</button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <datalist id="cur-ids">{opts.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</datalist>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={() => change(l => [...l, blank()])}>Add recipe</button>
        <span className="hint">A red border means the trade id isn't in the currency list; the recipe is ignored until it matches.</span>
      </div>
    </>
  )
  return embedded ? body : <div className="single"><h2>Off-exchange conversions</h2>{body}</div>
}
