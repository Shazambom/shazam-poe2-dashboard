import React, { useEffect, useState } from 'react'
import { api, fmt, surface } from '../lib/api.js'
import { useAutosave } from '../lib/hooks.js'
import Cur from './Cur.jsx'
import CurrencyPicker from './CurrencyPicker.jsx'
import Wealth, { useWealthText } from './Wealth.jsx'

const PRIMARY = ['chaos', 'exalted', 'divine']

// Compact per-row sub-line under the currency name (the rail is too narrow for extra columns):
// paper worth, and — only when it differs — what it ACTUALLY cashes out to, with a ghost hint.
// `partial` = the book can't absorb the whole stack; a `▼x%` tag flags all-in loss; `no market
// data` = we have no tracked exchange market for it. Cash-like holdings just show their worth.
function worthLine(v, qtyStr, ref, backfilling, wtext) {
  if (!v || v.value_ref == null) {
    return Number(qtyStr) > 0 ? <span className="muted" title={backfilling ? 'valued once market data finishes syncing' : 'no market rate yet'}>…</span> : ''
  }
  const worth = <Wealth v={v.value_ref} cur={ref} size={13} />
  if (v.realizable_ref == null) {
    return <>{worth} <span className="muted" title="no tracked exchange market for this currency, so its cash-out can't be measured">· no market data</span></>
  }
  const ghost = v.value_ref - v.realizable_ref
  const ghostPct = v.value_ref > 0 ? ghost / v.value_ref * 100 : 0    // all-in loss: slippage + gold + stranded
  let tail = null
  if (v.full_fill === false) tail = <span className="cap-ghost" title={`the market can't absorb the whole stack right now — 👻 ${wtext(ghost, ref)} ghost`}> → <Wealth v={v.realizable_ref} cur={ref} size={13} /> partial</span>
  else if (ghostPct >= 1) tail = <span className="cap-ghost" title={`cash out via best path · 👻 ${wtext(ghost, ref)} ghost (slippage + gold)`}> → <Wealth v={v.realizable_ref} cur={ref} size={13} /> ▼{ghostPct.toFixed(0)}%</span>
  return <>{worth}{tail}</>
}

// What-you-hold editor that lives in the Routes rail. Quantities auto-save
// (debounced via the shared useAutosave hook) — no Save button, no separate page.
export default function CapitalCard({ currencies, status, onSaved }) {
  const [qty, setQty] = useState(null)          // { currency: "string qty" } as typed
  const [data, setData] = useState(null)        // last server valuation

  const { state, save, arm } = useAutosave(async (rows) => {
    const entries = {}
    Object.entries(rows).forEach(([c, v]) => { const n = Number(v); if (Number.isFinite(n) && n > 0) entries[c] = n })
    const d = await surface(api.putCapital(entries))
    setData(d); onSaved?.()
  })

  useEffect(() => {
    api.capital().then(d => {
      setData(d)
      const r = Object.fromEntries(PRIMARY.map(p => [p, 0]))
      d.rows.forEach(x => { r[x.currency] = x.qty })
      setQty(r); arm()
    }).catch(() => { setQty(Object.fromEntries(PRIMARY.map(p => [p, 0]))); arm() })
  }, []) // eslint-disable-line

  const setOne = (c, v) => setQty(r => { const n = { ...r, [c]: v }; save(n); return n })
  const remove = (c) => setQty(r => { const n = { ...r }; delete n[c]; save(n); return n })
  const valueOf = (c) => data?.rows.find(r => r.currency === c)
  const backfilling = status?.digest?.backfilling
  const ref = data?.reference ?? 'exalted'
  const wtext = useWealthText()

  if (!qty) return <div className="hint">Loading capital…</div>
  const ghost = data?.ghost_ref
  return (
    <div className="capcard">
      <h2>What you hold <span className="save-state">{state === 'saving' ? 'saving…' : state === 'saved' ? 'saved ✓' : ''}</span></h2>
      {/* A grid, not a table: the rail is narrow, and a table's auto layout let a long name or
          worth line shove the quantity box and × out through the card's edge. Name truncates, the
          box and × keep fixed columns, the worth line gets the full row width underneath. */}
      <div className="cap-rows">
        {Object.keys(qty).map(c => (
          <div className="cap-row" key={c}>
            <span className="cap-name"><Cur id={c} text /></span>
            <input type="number" min="0" step="1" value={qty[c]} aria-label={`${c} held`}
              onChange={e => setOne(c, e.target.value)} />
            {PRIMARY.includes(c) ? <span /> : <button className="cap-x" title="Remove" aria-label={`Remove ${c}`} onClick={() => remove(c)}>×</button>}
            <div className="cap-sub">{worthLine(valueOf(c), qty[c], ref, backfilling, wtext)}</div>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <CurrencyPicker value="" placeholder="Add currency…"
          options={(currencies?.currencies ?? []).filter(c => !(c.id in (qty || {})))}
          onChange={id => { if (id && !(id in (qty || {}))) setQty(r => ({ ...r, [id]: 0 })) }} />
      </div>
      <p className="hint" style={{ marginTop: 6 }}>
        Total <b><Wealth v={data?.total_ref} cur={ref} /></b>
        {data?.realizable_total_ref != null && <> · realizable <b><Wealth v={data.realizable_total_ref} cur={ref} /></b></>}
        {ghost > 0.5 && <> <span className="cap-ghost" title="Paper value you can't currently cash out (slippage + thin books)">(👻 <Wealth v={ghost} cur={ref} size={12} /> ghost)</span></>}
        <br />loops are sized from these counts.
      </p>
    </div>
  )
}
