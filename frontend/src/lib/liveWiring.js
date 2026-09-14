import React, { useEffect } from 'react'
import { toast as sonner } from 'sonner'
import { usePings } from './pingStore.js'
import { playPing, unlockSound } from './ping-sound.js'
import { nav } from './nav.js'

const isDesktop = typeof window !== 'undefined' && !!window.poe2desktop?.trade

// Mounted once in App. Subscribes to the desktop live-search engine and turns each ping
// into: (1) a store entry, (2) a sound, (3) an OS notification, (4) a sonner banner that
// bubbles the newest ping to the top with a jump-to-Live action. Inert on web.
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
        try { sonner.custom((id) => bannerEl(ping, () => { sonner.dismiss(id); goLive?.() }), { id: 'live-ping', duration: Infinity }) } catch {}
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

      playPing()
      // OS notification (Electron routes renderer Notifications to the native notifier;
      // survives a hidden window). Permission is effectively granted in Electron.
      try {
        if ('Notification' in window) {
          const n = new Notification(`Ping: ${p.item?.name || 'item'}`, {
            body: p.price ? `${p.price.amount} ${p.price.currency} · ${p.online}` : p.online,
            tag: p.pingId, silent: true,
          })
          n.onclick = () => { goLive?.(); window.focus?.() }
        }
      } catch {}
      // In-app most-recent-ping banner (persistent, replaced by each newer ping).
      sonner.custom((id) => bannerEl(p, () => { sonner.dismiss(id); goLive?.() }), { id: 'live-ping', duration: Infinity })
    })
    const offEngine = window.poe2desktop.trade.onEngineState((e) => usePings.getState().setEngine(e))
    return () => { offPing?.(); offEngine?.(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock) }
  }, [goLive])
}

// sonner's toast.custom render fn must return a REACT node (not a DOM element — that
// throws React #31). Build it with createElement to keep this a plain .js module.
function bannerEl(p, onOpen) {
  const h = React.createElement
  return h('div', { className: 'ping-banner' },
    h('span', { className: `pb-dot ${p.online}` }),
    h('div', { className: 'pb-main' },
      h('div', { className: 'pb-name' }, `Ping: ${p.item?.name || p.item?.typeLine || 'item'}`),
      h('div', { className: 'pb-sub muted' }, p.price ? `${p.price.amount} ${p.price.currency} · ${p.online}` : p.online)),
    h('button', { className: 'btn small primary pb-go', onClick: onOpen }, 'Open'))
}
