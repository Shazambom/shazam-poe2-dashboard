import React, { useEffect } from 'react'
import { useMachine } from '@xstate/react'
import { pingMachine, buttonView } from '../lib/pingMachine.js'
import { usePings } from '../lib/pingStore.js'
import { toast, cleanErr } from '../lib/api.js'
import Cur from './Cur.jsx'

// The one button for all watches: the newest ping's travel-to-hideout action. STRICTLY
// human-triggered — one click = exactly one whisper POST (the only caller of the teleport
// IPC). Disabled while in-flight so a double-click can't double-fire. The XState machine
// drives both this button and (via pingStore.states) the VaalPingOrb intensity.
const PRESENCE = { online: '#6fce9f', afk: '#e0a83a', offline: '#e8615f' }

export default function PingButton({ ping, compact = false }) {
  const [snapshot, send] = useMachine(pingMachine)
  const setState = usePings(s => s.setState)
  const state = snapshot.value

  useEffect(() => { setState(ping.pingId, state) }, [state, ping.pingId, setState])

  // Token expiry (~5 min) → expired, without a click.
  useEffect(() => {
    if (!ping.tokenExp) return
    const ms = ping.tokenExp - Date.now()
    if (ms <= 0) { send({ type: 'EXPIRE' }); return }
    const t = setTimeout(() => send({ type: 'EXPIRE' }), ms)
    return () => clearTimeout(t)
  }, [ping.tokenExp, send])

  useEffect(() => { if (ping.flags?.gone) send({ type: 'GONE' }) }, [ping.flags?.gone, send])

  const view = buttonView(state)

  const onClick = async () => {
    if (!view.enabled) return
    if (!window.poe2desktop?.trade) { toast('Teleport runs in the desktop app', false); return }
    if (!ping.token) { toast('This listing has no travel token', false); return }
    send({ type: 'SEND' })
    try {
      const r = await window.poe2desktop.trade.teleport(ping.token)
      if (r?.success) send({ type: 'OK' })
      else if (r?.error === 'RATE_LIMITED') { send({ type: 'RATE' }); toast(`Rate-limited — retry in ${r.retryAfter || 30}s`, false) }
      else if (r?.status && r.status >= 400) { send({ type: 'ERR' }); toast(`Trade error ${r.status}`, false) }
      else send({ type: 'FALSE' })   // {success:false} = contested / already sold
    } catch (e) { send({ type: 'ERR' }); toast(cleanErr(e), false) }
  }

  const dot = PRESENCE[ping.online] || PRESENCE.offline
  return (
    <div className={`ping-card ${compact ? 'compact' : ''}`}>
      <span className="ping-icon"><Cur name={ping.item?.name} size={compact ? 18 : 22} /></span>
      <div className="ping-info">
        <div className="ping-name">{ping.item?.name || ping.item?.typeLine || 'Item'}</div>
        <div className="ping-sub muted">
          {ping.price ? <><b>{ping.price.amount}</b> <Cur id={ping.price.currency} size={12} /></> : 'unpriced'}
          <span className="ping-presence" style={{ color: dot }}>● {ping.online}</span>
          {ping.flags?.inDemand && <span className="live-badge">in demand</span>}
        </div>
      </div>
      <button className={`btn teleport ${view.cls}`} disabled={!view.enabled} onClick={onClick}>{view.label}</button>
    </div>
  )
}
