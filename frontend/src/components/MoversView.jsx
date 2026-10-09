import React, { useMemo } from 'react'
import { api, fmt } from '../lib/api.js'
import { useApi } from '../lib/hooks.js'
import Cur from './Cur.jsx'
import Wealth from './Wealth.jsx'
import { useAssetModal, rangeLabel } from './CardDetail.jsx'
import { useHorizon } from '../lib/horizonStore.js'

// Economy → Top movers (owner, 2026-10-08: broken out of Hold): the biggest upward swings across every currency over
// the app-wide window, most first. A row opens the same zoom modal the Board uses.
const MOVERS_N = 50  // a full leaderboard, not the board's top-3 pulse

export default function MoversView() {
  const hours = useHorizon(s => s.hours)
  const assetModal = useAssetModal()
  const mv = useApi(() => api.movers(hours, MOVERS_N, 'up'), [hours])
  const rows = useMemo(() => mv.data?.assets ?? [], [mv.data])
  const horizon = rangeLabel(hours)          // the app-wide window, named as the top bar names it (24h / 3d / 7d / 14d)
  return (
    <div className="single hold">
      <div className="board-bar">
        <h2 style={{ margin: 0 }}>Top movers <span className="muted" style={{ fontWeight: 400 }}>· biggest upward swings across all currencies over {horizon}{mv.data?.league ? ` · ${mv.data.league}` : ''}</span></h2>
      </div>
      {mv.err && <div className="notice error">{mv.err}</div>}
      {mv.busy && rows.length === 0 && <table><tbody>{Array.from({ length: 6 }).map((_, i) => <tr key={i}><td colSpan={5}><div className="sk sk-row" /></td></tr>)}</tbody></table>}
      {!mv.busy && rows.length === 0 && <div className="empty">No upward movers over {horizon} yet.</div>}
      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>#</th><th>Asset</th><th>Category</th>
              <th className="num" title={`% change over ${horizon}`}>Change</th>
              <th className="num" title="Median daily traded value (Exalted/day) — liquidity">Volume</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className="route" title={`Expand ${r.name}`} onClick={() => assetModal.open(r.name, r.num)}>
                <td className="muted">{i + 1}</td>
                <td><Cur name={r.name} text /></td>
                <td className="muted">{r.category}</td>
                <td className="num gain">{fmt.pct(r.change_pct)}</td>
                <td className="num muted"><Wealth v={r.medvol} cur="exalted" size={12} suffix="/day" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {assetModal.node}
    </div>
  )
}
