import { useEffect, useReducer, useRef } from 'react'
import { pingTransition, TIMED_TRANSITIONS, buttonView } from '../lib/pingMachine.js'
import { toast, cleanErr } from '../lib/api.js'
import { presence as PRESENCE } from '../theme.js'
import Cur from './Cur.jsx'

// The one button for all watches: the newest ping's travel-to-hideout action. STRICTLY
// human-triggered — one click = exactly one whisper POST (the only caller of the teleport
// IPC). Disabled while in-flight so a double-click can't double-fire. The FSM reducer
// drives this button; the VaalPingOrb derives its intensity from the newest ping itself.
// Presence colors (online/afk/offline) come from the shared theme — the SAME set the
// CSS `.pb-dot` rules use — so the two never drift. See theme.js / docs/ui-styleguide.md.

export default function PingButton({ ping, compact = false }) {
  const [state, send] = useReducer(pingTransition, 'fresh')
  const pingIdRef = useRef(ping.pingId)

  // Defensive reset if a caller ever swaps `ping` in place without re-keying by pingId.
  useEffect(() => {
    if (pingIdRef.current !== ping.pingId) {
      pingIdRef.current = ping.pingId
      send({ type: 'NEW_PING' })
    }
  }, [ping.pingId])

  // Timed state transitions (fresh → stale after 45 s; rateLimited → fresh after 30 s).
  useEffect(() => {
    const timed = TIMED_TRANSITIONS[state]
    if (!timed) return
    const t = setTimeout(() => send(timed.event), timed.ms)
    return () => clearTimeout(t)
  }, [state, ping.pingId])

  // Token expiry (~5 min) → expired, without a click.
  useEffect(() => {
    if (!ping.tokenExp) return
    const ms = ping.tokenExp - Date.now()
    if (ms <= 0) { send({ type: 'EXPIRE' }); return }
    const t = setTimeout(() => send({ type: 'EXPIRE' }), ms)
    return () => clearTimeout(t)
  }, [ping.pingId, ping.tokenExp])

  useEffect(() => { if (ping.flags?.gone) send({ type: 'GONE' }) }, [ping.pingId, ping.flags?.gone])

  const view = buttonView(state)

  const onClick = async () => {
    if (!view.enabled) return
    if (!window.poe2desktop?.trade) { toast('Teleport runs in the desktop app', false); return }
    if (!ping.token) { toast('This listing has no travel token', false); return }
    const clickPingId = ping.pingId
    send({ type: 'SEND' })
    try {
      const r = await window.poe2desktop.trade.teleport(ping.token)
      if (pingIdRef.current !== clickPingId) return
      if (r?.success) send({ type: 'OK' })
      else if (r?.error === 'RATE_LIMITED') { send({ type: 'RATE' }); toast(`Rate-limited — retry in ${r.retryAfter || 30}s`, false) }
      else if (r?.status && r.status >= 400) { send({ type: 'ERR' }); toast(`Trade error ${r.status}`, false) }
      else send({ type: 'FALSE' })   // {success:false} = contested / already sold
    } catch (e) {
      if (pingIdRef.current !== clickPingId) return
      send({ type: 'ERR' }); toast(cleanErr(e), false)
    }
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
