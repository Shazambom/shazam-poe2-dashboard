import React, { useEffect, useMemo, useRef, useState } from 'react'
import { usePings, liveLabel } from '../lib/pingStore.js'
import { useWorkspace, loadWorkspace } from '../lib/workspaceStore.js'
import PingButton from './PingButton.jsx'
import SearchTree from './SearchTree.jsx'
import { toast } from '../lib/api.js'
import { hasTradeEngine as isDesktop } from '../lib/session.js'
import { flatten } from '../lib/tree.js'

// Trading → Live: the live-search cockpit. Newest ping surfaces at the top as the single
// travel-to-hideout button ("one button for all watches"); watched searches can be toggled
// live (desktop-only). Web shows the desktop steer.
const flattenSearches = (nodes) => flatten(nodes, n => n.kind === 'search')

export default function LiveView({ league }) {
  const pings = usePings(s => s.pings)
  const markSeen = usePings(s => s.markSeen)
  const engine = usePings(s => s.engine)
  const searchStates = usePings(s => s.searchStates)
  const tree = useWorkspace(s => s.tree)
  const loaded = useWorkspace(s => s.loaded)
  const loadError = useWorkspace(s => s.loadError)
  const setField = useWorkspace(s => s.setField)
  // Go-live state is the DB-persisted `armed` flag on each node (single source of truth).
  // useLiveSync reconciles the engine to it; `searchStates` is the engine's per-search verdict.
  const headRef = useRef(null)

  useEffect(() => { if (!loaded) loadWorkspace() }, [loaded])
  useEffect(() => { markSeen() }, [markSeen])   // entering Live clears the unseen badge
  // liveLabel() times out a silent connect after 15 s; re-evaluate every 5 s so the label moves.
  const [, tick] = useState(0)
  useEffect(() => { const t = setInterval(() => tick(n => n + 1), 5000); return () => clearInterval(t) }, [])

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

  // Toggling just flips the persisted `armed` flag; useLiveSync starts/stops the engine.
  const toggleLive = (node) => {
    if (!isDesktop) { toast('Live search runs in the desktop app', false); return }
    if (!league) { toast('No league set — pick one in the top bar', false); return }
    if (!node.armed && !node.slug) { toast('Open this search and run it once first, then go live', false); return }
    setField(node.id, { armed: !node.armed })
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
    <div className="trade-ws live-view">
      <aside className="ws-rail">
        <div className="ws-rail-head">
          <b>Watched searches</b>
          <span className="ws-chip" title="Live searches running / engine cap">{engine.active}/{engine.budgetMax} live</span>
        </div>
        {loadError
          ? <div className="notice error ws-load-error" role="alert"><b>Couldn't load your searches</b><span className="muted">{loadError}</span><button className="btn small" onClick={() => loadWorkspace()}>Retry</button></div>
          : searches.length === 0
          ? <div className="empty small">No saved searches yet — add some in Workspace.</div>
          : (
            <SearchTree
              onSelect={() => {}}
              renderTrailing={(d) => {
                if (d.kind !== 'search') return null
                const { text, title } = liveLabel(d, searchStates[d.id])
                return (
                  <button className={`btn small ${d.armed ? 'primary' : ''}`} title={title}
                          onClick={e => { e.stopPropagation(); toggleLive(d) }}>
                    {text}
                  </button>
                )
              }}
            />
          )}
      </aside>

      <section className="ws-main live-main">
        <div className="live-head">
          <b>Live</b>
          <span className="spacer" />
          {pings.length > 0 && <button className="btn small" onClick={() => usePings.getState().clear()}>Clear</button>}
        </div>
        <div className="live-newest" ref={headRef}>
          {newest
            ? <PingButton ping={newest} />
            : <div className="empty small live-placeholder">Armed watches ping here.</div>}
        </div>
        {rest.length > 0 && (
          <div className="live-recent">
            <div className="live-recent-head muted">Recent</div>
            {rest.map(p => <PingButton key={p.pingId} ping={p} compact />)}
          </div>
        )}
      </section>
    </div>
  )
}
