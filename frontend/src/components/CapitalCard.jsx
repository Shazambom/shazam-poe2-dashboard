import React, { useEffect, useState } from 'react'
import { api, fmt, surface } from '../lib/api.js'
import { useAutosave } from '../lib/hooks.js'
import { useStatus } from '../lib/statusStore.js'
import { useSync } from '../lib/syncStore.js'
import Cur from './Cur.jsx'
import CurrencyPicker from './CurrencyPicker.jsx'
import Wealth, { Native, useWealthText } from './Wealth.jsx'
import { holdingLine } from '../lib/capital.js'

const PRIMARY = ['chaos', 'exalted', 'divine']

// Compact per-row sub-line under the currency name (the rail is too narrow for extra columns), by
// the volume rule (lib/capital.js holdingLine): a traded holding's worth at its market's rate, and
// — only when it differs — what it ACTUALLY cashes out to, in the cash currency the sale ends in,
// with a ghost hint. A cash holding's quantity is already its native amount: no line. `partial` =
// the book can't absorb the whole stack; `▼x%` = all-in loss; `no market data` = no tracked market.
function worthLine(v, qtyStr, ref, backfilling, wtext) {
  const l = holdingLine(v)
  if (!l) {
    return Number(qtyStr) > 0 ? <span className="muted" title={backfilling ? 'valued once market data finishes syncing' : 'no market rate yet'}>…</span> : ''
  }
  const worth = l.worth && <Native v={l.worth.amount} cur={l.worth.cur} vRef={l.worth.ref} size={13} />
  if (l.noMarket) {
    return <>{worth} <span className="muted" title="no tracked exchange market for this currency, so its cash-out can't be measured">· no market data</span></>
  }
  let tail = null
  if (l.cashout) {
    const ghost = v.value_ref - v.realizable_ref
    const out = <Native v={l.cashout.amount} cur={l.cashout.cur} vRef={l.cashout.ref} size={13} />
    tail = l.partial
      ? <span className="cap-ghost" title={`the market can't absorb the whole stack right now — 👻 ${wtext(ghost, ref)} ghost`}> → {out} partial</span>
      : <span className="cap-ghost" title={`cash out via best path · 👻 ${wtext(ghost, ref)} ghost (slippage + gold)`}> → {out} ▼{l.ghostPct.toFixed(0)}%</span>
  }
  return <>{worth}{tail}</>
}

// What-you-hold editor that lives in the Routes rail. Quantities auto-save
// (debounced via the shared useAutosave hook) — no Save button, no separate page.
export default function CapitalCard({ currencies, status, onSaved }) {
  const [qty, setQty] = useState(null)          // { currency: "string qty" } as typed

  // The valuation comes from the ONE capital fetch the app already makes (statusStore polls it
  // every 30s and refreshes it after a gold-price change), so the card re-prices with everything
  // else instead of fetching its own copy on a different schedule. A save's response wins over a
  // poll that lands after it (`saved`), so a refresh never rolls the numbers back.
  const shared = useStatus(s => s.capital)
  const [saved, setSaved] = useState(null)
  const data = saved ?? shared
  const { state, save, arm } = useAutosave(async (rows) => {
    const entries = {}
    Object.entries(rows).forEach(([c, v]) => { const n = Number(v); if (Number.isFinite(n) && n > 0) entries[c] = n })
    const d = await surface(api.putCapital(entries))
    setSaved(d); useStatus.setState({ capital: d }); onSaved?.()
  })

  // Quantities are seeded once, from whichever copy arrives first, and then owned by the input:
  // a refresh must never overwrite what you are typing.
  useEffect(() => {
    if (qty || !shared) return
    const r = Object.fromEntries(PRIMARY.map(p => [p, 0]))
    shared.rows.forEach(x => { r[x.currency] = x.qty })
    setQty(r); arm()
  }, [shared]) // eslint-disable-line
  const tick = useSync(s => s.tick)
  useEffect(() => { if (tick > 0) setSaved(null) }, [tick])   // ⟳: trust the shared copy again

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
