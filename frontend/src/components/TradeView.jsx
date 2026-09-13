import React, { useEffect, useRef, useState } from 'react'
import { api, toast } from '../lib/api.js'
import { parseTradeUrl } from '../lib/session.js'

// Full pathofexile.com trade site embedded in the app via an Electron <webview>.
// It shares the app's logged-in session, so search, live search, results and
// whisper-copy all work in-window. Desktop-only (a browser can't frame another
// origin). Everything is human-driven — we only host the site, we don't touch it.
const uid = () => Math.random().toString(36).slice(2, 9)
const home = (league) => `https://www.pathofexile.com/trade2/search/${encodeURIComponent(league || 'Standard')}`

export default function TradeView({ league }) {
  const wv = useRef(null)
  const [url, setUrl] = useState('')
  const [nav, setNav] = useState({ back: false, fwd: false, loading: true })
  const supported = typeof window !== 'undefined' && !!window.poe2desktop

  useEffect(() => {
    const el = wv.current
    if (!el || !supported) return
    const sync = () => { try { setUrl(el.getURL()); setNav({ back: el.canGoBack(), fwd: el.canGoForward(), loading: false }) } catch {} }
    const start = () => setNav(n => ({ ...n, loading: true }))
    el.addEventListener('did-navigate', sync)
    el.addEventListener('did-navigate-in-page', sync)
    el.addEventListener('dom-ready', sync)
    el.addEventListener('did-start-loading', start)
    el.addEventListener('did-stop-loading', sync)
    return () => {
      el.removeEventListener('did-navigate', sync); el.removeEventListener('did-navigate-in-page', sync)
      el.removeEventListener('dom-ready', sync); el.removeEventListener('did-start-loading', start)
      el.removeEventListener('did-stop-loading', sync)
    }
  }, [supported])

  if (!supported) {
    return (
      <div className="single">
        <div className="empty">
          <b>The in-app trade browser is desktop-only.</b><br />
          Open the desktop app to browse the full pathofexile.com trade site here, logged in.
          In a plain browser, use the <b>Watches</b> tab to open searches in new tabs instead.
        </div>
      </div>
    )
  }

  const saveCurrent = async () => {
    const p = parseTradeUrl(url)
    if (!p) { toast('Open a trade search first, then save it', false); return }
    try {
      const d = await api.watches(); const folders = d.folders || []
      let f = folders.find(x => x.title === 'Captured')
      if (!f) { f = { id: uid(), title: 'Captured', open: true, searches: [] }; folders.push(f) }
      f.searches.push({ id: uid(), title: `Search ${p.slug.slice(0, 6)}`, type: p.type, slug: p.slug, live: p.live, done: false })
      await api.putWatches(folders)
      toast('Saved to Watches → Captured')
    } catch (e) { toast(String(e.message || e), false) }
  }

  const el = () => wv.current
  return (
    <div className="trade-wrap">
      <div className="trade-bar">
        <button className="btn small" disabled={!nav.back} onClick={() => el().goBack()} title="Back">◀</button>
        <button className="btn small" disabled={!nav.fwd} onClick={() => el().goForward()} title="Forward">▶</button>
        <button className="btn small" onClick={() => el().reload()} title="Reload">⟳</button>
        <button className="btn small" onClick={() => el().loadURL(home(league))} title="Trade home for this league">Home</button>
        <span className="trade-url muted" title={url}>{nav.loading ? 'loading…' : url}</span>
        <span className="spacer" />
        <button className="btn small primary" onClick={saveCurrent} disabled={!parseTradeUrl(url)}>Save to Watches</button>
      </div>
      <webview ref={wv} src={home(league)} className="trade-webview" allowpopups="true" />
    </div>
  )
}
