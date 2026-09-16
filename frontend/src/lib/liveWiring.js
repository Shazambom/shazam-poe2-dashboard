import React, { useEffect } from 'react'
import { usePings } from './pingStore.js'
import { useWorkspace, loadWorkspace } from './workspaceStore.js'
import { toast, bus } from './api.js'
import { unlockSound } from './ping-sound.js'
import { notify } from './notifications.js'
import { nav } from './nav.js'
import { hasTradeEngine as isDesktop } from './session.js'

const PING_TTL = 10000   // top-right ping banner auto-dismisses after 10s (or when a newer ping replaces it)

// Mounted once in App. Subscribes to the desktop live-search engine and turns each ping into a
// store entry plus a `notify('live', …)` — banner in the app's one toast stack (newest ping replaces
// the last, with a jump-to-Live action), sound, OS notification — each gated by Settings →
// Notifications. Inert on web.
const alertPing = (p, goLive) => notify('live', {
  id: 'live-ping', ttl: PING_TTL, tag: p.pingId,
  title: `Ping: ${p.item?.name || 'item'}`,
  body: p.price ? `${p.price.amount} ${p.price.currency} · ${p.online}` : p.online,
  node: bannerEl(p, () => { bus.emit({ id: 'live-ping', dismiss: true }); goLive?.() }),
  onOpen: () => goLive?.(),
})
export function useLiveWiring(goLive) {
  useEffect(() => {
    // Dev/test hook (stripped from production builds): inject a synthetic ping to validate
    // the alert UI in a plain browser where the desktop engine isn't present.
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      window.__arbiterTestPing = (p) => {
        const ping = p || { pingId: `p_test_${Date.now()}`, itemId: 'test', searchId: 'test',
          listingId: `test_${Date.now()}`, item: { name: 'Divine Orb', typeLine: 'Divine Orb' },
          price: { amount: 3, currency: 'chaos' }, account: 'TestSeller', online: 'online',
          indexedAt: Date.now(), receivedAt: Date.now(), token: null, tokenExp: Date.now() + 3e5,
          flags: { gone: false, inDemand: true } }
        usePings.getState().addPing(ping)
        alertPing(ping, goLive)
      }
    }
    // Unlock WebAudio on the first user gesture (browser autoplay policy).
    const unlock = () => { unlockSound(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock) }
    window.addEventListener('pointerdown', unlock)
    window.addEventListener('keydown', unlock)
    if (!isDesktop) return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock) }

    const st = usePings.getState()
    const offPing = window.poe2desktop.trade.onPing((p) => {
      const before = usePings.getState().pings.length
      st.addPing(p)
      const after = usePings.getState().pings.length
      if (after === before) return   // deduped — don't re-alert

      alertPing(p, goLive)
    })
    const offEngine = window.poe2desktop.trade.onEngineState((e) => usePings.getState().setEngine(e))
    // Per-search connection state (live / auth / reconnecting / error) drives the Live button
    // label, so an expired session or a dropped socket is visible instead of a stuck "Live …".
    const offSearch = window.poe2desktop.trade.onSearchState((s) => usePings.getState().setSearchState(s))
    const offErr = window.poe2desktop.trade.onEngineError((e) => { if (e?.message) toast(e.message, false) })
    return () => { offPing?.(); offEngine?.(); offSearch?.(); offErr?.(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock) }
  }, [goLive])
}

// Keep the live-search ENGINE reconciled to the DB: every search node with armed:true (and
// a slug) should be running; everything else stopped. Runs on load (resume across restarts)
// and whenever the armed set changes. The DB (trading_workspace) is the single source of
// truth for go-live state; the engine is a slave to it.
export function useLiveSync(league) {
  useEffect(() => {
    if (!isDesktop) return
    if (!useWorkspace.getState().loaded) loadWorkspace()
    let lastKey = ''
    const armedNodes = () => {
      const out = []
      const walk = (ns) => (ns || []).forEach(n => { if (n.kind === 'search' && n.armed && n.slug) out.push(n); if (n.children) walk(n.children) })
      walk(useWorkspace.getState().tree)
      return out
    }
    const reconcile = () => {
      const st = useWorkspace.getState()
      if (!st.loaded || !league) return
      const armed = armedNodes()
      const desired = armed.map(n => n.id).sort()
      const key = league + '|' + desired.join(',')
      if (key === lastKey) return
      lastKey = key
      const current = new Set(usePings.getState().engine.activeIds || [])
      armed.forEach(n => {
        if (!current.has(n.id)) window.poe2desktop.trade.startSearch(n.id, league, n.slug, n.type)
          .then(r => { if (r && !r.ok && r.reason === 'budget') { useWorkspace.getState().setField(n.id, { armed: false }); toast('Live-search cap reached — stop one first', false) } })
          .catch(() => {})
      })
      current.forEach(id => { if (!desired.includes(id)) window.poe2desktop.trade.stopSearch(id).catch(() => {}) })
    }
    const unsubWs = useWorkspace.subscribe(reconcile)
    const unsubEng = usePings.subscribe((s, p) => { if ((s.engine.activeIds || []).length !== (p.engine.activeIds || []).length) reconcile() })
    reconcile()
    return () => { unsubWs(); unsubEng() }
  }, [league])
}

// The banner is a REACT node rendered inside the toast stack. Built with createElement to keep
// this a plain .js module.
function bannerEl(p, onOpen) {
  const h = React.createElement
  return h('div', { className: 'ping-banner' },
    h('span', { className: `pb-dot ${p.online}` }),
    h('div', { className: 'pb-main' },
      h('div', { className: 'pb-name' }, `Ping: ${p.item?.name || p.item?.typeLine || 'item'}`),
      h('div', { className: 'pb-sub muted' }, p.price ? `${p.price.amount} ${p.price.currency} · ${p.online}` : p.online)),
    h('button', { className: 'btn small primary pb-go', onClick: onOpen }, 'Open'))
}
