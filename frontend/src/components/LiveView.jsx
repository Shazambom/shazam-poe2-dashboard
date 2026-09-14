import React, { useEffect, useMemo, useRef, useState } from 'react'
import { usePings } from '../lib/pingStore.js'
import { useWorkspace, loadWorkspace } from '../lib/workspaceStore.js'
import PingButton from './PingButton.jsx'
import { toast } from '../lib/api.js'

const isDesktop = typeof window !== 'undefined' && !!window.poe2desktop?.trade

// Trading → Live: the live-search cockpit. Newest ping surfaces at the top as the single
// travel-to-hideout button ("one button for all watches"); watched searches can be toggled
// live (desktop-only). Web shows the desktop steer.
// One-time safety/ToS note: this uses your own logged-in session against GGG's unofficial
// trade API; every teleport is a manual click (never automated), and the app obeys rate
// limits. Dismissal persists.
function TosNote() {
  const [ack, setAck] = useState(() => { try { return localStorage.getItem('arbiter_live_ack') === '1' } catch { return false } })
  if (ack) return null
  return (
    <div className="tos-note">
      <span>⚠ Live search uses <b>your own</b> pathofexile.com session. Every travel-to-hideout is a
        manual click — nothing is auto-bought — and Arbiter obeys the trade rate limits. This is GGG's
        unofficial API; keep it human-paced.</span>
      <button className="btn small" onClick={() => { try { localStorage.setItem('arbiter_live_ack', '1') } catch {} setAck(true) }}>Got it</button>
    </div>
  )
}

function flattenSearches(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.kind === 'search') out.push(n)
    if (n.children) flattenSearches(n.children, out)
  }
  return out
}

export default function LiveView({ league }) {
  const pings = usePings(s => s.pings)
  const markSeen = usePings(s => s.markSeen)
  const engine = usePings(s => s.engine)
  const tree = useWorkspace(s => s.tree)
  const loaded = useWorkspace(s => s.loaded)
  const [liveIds, setLiveIds] = useState(() => new Set())
  const headRef = useRef(null)

  useEffect(() => { if (!loaded) loadWorkspace() }, [loaded])
  useEffect(() => { markSeen() }, [markSeen])   // entering Live clears the unseen badge

  // Hotkey/orb → focus the newest ping's button.
  useEffect(() => {
    if (!isDesktop) return
    return window.poe2desktop.trade.onFocusLive(() => {
      setTimeout(() => headRef.current?.querySelector('button.teleport')?.focus(), 50)
    })
  }, [])

  const searches = useMemo(() => flattenSearches(tree), [tree])
  const newest = pings[0] || null
  const rest = pings.slice(1, 25)

  const toggleLive = async (node) => {
    if (!isDesktop) { toast('Live search runs in the desktop app', false); return }
    if (!league) { toast('No league set — pick one in the top bar', false); return }
    const on = liveIds.has(node.id)
    try {
      if (on) { await window.poe2desktop.trade.stopSearch(node.id); setLiveIds(s => { const n = new Set(s); n.delete(node.id); return n }) }
      else {
        const r = await window.poe2desktop.trade.startSearch(node.id, league, node.slug, node.type)
        if (r?.ok) setLiveIds(s => new Set(s).add(node.id))
        else if (r?.reason === 'budget') toast(`Live-search cap reached (${engine.budgetMax}). Stop one first.`, false)
      }
    } catch (e) { toast(String(e.message || e), false) }
  }

  // On web with nothing to show, steer to the desktop app. Once pings exist (desktop),
  // the cockpit renders; individual actions (Go live, teleport) degrade on their own.
  if (!isDesktop && pings.length === 0) {
    return (
      <div className="live-empty">
        <p className="live-empty-title">Live search</p>
        <p className="muted">Live-search pings + one-click travel-to-hideout run in the Arbiter desktop app
          (they use your logged-in trade session). Open the desktop app to arm your watches.</p>
      </div>
    )
  }

  return (
    <div className="live-view">
      <TosNote />
      <div className="live-head">
        <b>Live</b>
        <span className="muted">· {engine.active}/{engine.budgetMax} searches live</span>
        <span className="spacer" />
        {pings.length > 0 && <button className="btn small" onClick={() => usePings.getState().clear()}>Clear</button>}
      </div>

      <div className="live-newest" ref={headRef}>
        {newest
          ? <PingButton ping={newest} />
          : <div className="empty">Armed watches will ping here. Toggle a search live below.</div>}
      </div>

      {rest.length > 0 && (
        <div className="live-recent">
          <div className="live-recent-head muted">Recent</div>
          {rest.map(p => <PingButton key={p.pingId} ping={p} compact />)}
        </div>
      )}

      <div className="live-searches">
        <div className="live-recent-head muted">Watched searches</div>
        {searches.length === 0 && <div className="empty small">No saved searches yet — add some in Workspace.</div>}
        {searches.map(s => (
          <div className="live-srow" key={s.id}>
            <span className="ls-name">{s.name}</span>
            <span className="ls-slug muted">{s.type}/{String(s.slug).slice(0, 8)}</span>
            <span className="spacer" />
            <button className={`btn small ${liveIds.has(s.id) ? 'primary' : ''}`} onClick={() => toggleLive(s)}>
              {liveIds.has(s.id) ? 'Live ●' : 'Go live'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
