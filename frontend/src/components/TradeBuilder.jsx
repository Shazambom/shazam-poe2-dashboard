import React, { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { searchOfLink } from '../lib/session.js'
import { savedSearches, searchOfNode, useWorkspace } from '../lib/workspaceStore.js'
import { shouldAcceptNav } from '../lib/webview.js'
import { windowSearch } from '../lib/stratPricing.js'
import CurrencyPicker from './CurrencyPicker.jsx'


// "Build on trade…" (owner, 2026-10-01): the real trade site in a dialog, opened on `url`. The user
// picks mods and presses Search there as on the Trading tab. The window's own address is its search (a
// run search lands on a gzip slug; the ?q= it opens on reads too): followed through the app's
// trade:webview-nav event, filtered to this window, read with searchOfLink — and the page's own search
// from the trade tap (a run search can land on a short id). "Use this search" hands the
// last one to `onUse({ query, league })`; `onUnlink`, when given, drops a linked one.
// A pasted trade link or one of the Trading tab's searches links at once: the link is the search.
// `onOpenTrading`, when given, shows the linked search on the Trading tab. The page itself is never scripted or
// navigated by the app.
export default function TradeBuilder({ title, url, league, onUse, onClose, onUnlink = null, onOpenTrading = null }) {
  const trade = window.poe2desktop?.trade
  const wv = useRef(null)
  const [found, setFound] = useState(null)    // the search the window's address holds
  const tree = useWorkspace(s => s.tree)
  // The Trading tab's saved searches, by name (folder names find them too).
  const saved = useMemo(() => savedSearches(tree).filter(x => x.node.q || x.node.slug)
    .map(({ node, path }) => ({ id: node.id, name: node.name || 'Search', keywords: path, node })), [tree])
  const [bad, setBad] = useState(false)       // the pasted text is not a trade search link
  const take = (q) => { setBad(!q); if (q) onUse({ query: q, league }) }
  const fromLink = (link) => searchOfLink(link).then(take)

  useEffect(() => {
    const el = wv.current
    if (!el || !trade?.onWebviewNav) return
    const move = (e) => setFound(f => windowSearch(f, e))   // lib/stratPricing.js (tested with a fake trade site)
    searchOfLink(url).then(search => move({ kind: 'open', search }))   // the search it opens on
    let id = null
    const ready = () => { id = el.getWebContentsId() }
    el.addEventListener('dom-ready', ready, { once: true })
    const off = trade.onWebviewNav(p => {
      if (id == null || p.phase !== 'nav' || !shouldAcceptNav(p, id)) return
      searchOfLink(p.url).then(search => move({ kind: 'nav', search }))
    })
    // The page's own search (the trade tap): a run search can land on a short id its address doesn't carry.
    const offTap = trade.onTap?.(e => { if (id != null && e?.kind === 'search' && e.wcId === id) move({ kind: 'tap', body: e.body }) })
    return () => { el.removeEventListener('dom-ready', ready); off?.(); offTap?.() }
  }, []) // eslint-disable-line

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape' && !e.defaultPrevented) onClose() }   // an open list handles its own Esc
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const use = () => { if (found) onUse({ query: found, league }) }

  return (
    <motion.div className="detail-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={onClose}>
      <motion.div className="card-detail tb-dialog" role="dialog" aria-modal="true" aria-label={title}
        initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.18, ease: [0.22, 0.61, 0.36, 1] }} onClick={e => e.stopPropagation()}>
        <button className="cd-close" onClick={onClose} title="Close (Esc)">×</button>
        <div className="cd-head"><span className="cd-title">{title}</span></div>
        <webview ref={wv} src={url} className="ws-webview tb-webview" allowpopups="true" />
        <div className="tb-foot">
          <span className="muted">Pick mods, then press Search.</span>
          <input className="scalc-in tb-paste" type="text" placeholder="Paste a trade link" aria-invalid={bad || undefined}
            onPaste={e => { e.preventDefault(); fromLink(e.clipboardData.getData('text')) }}
            onKeyDown={e => { if (e.key === 'Enter') fromLink(e.currentTarget.value) }} onChange={() => setBad(false)} />
          {saved.length > 0 && (
            <span className="tb-saved">
              <CurrencyPicker value="" placeholder="Your searches…" options={saved} renderIcon={null}
                onChange={id => { const o = saved.find(x => x.id === id); if (o) searchOfNode(o.node, league).then(take) }} />
            </span>
          )}
          {onOpenTrading && <button type="button" className="btn" onClick={onOpenTrading}>Open in Trading</button>}
          {onUnlink && <button type="button" className="btn" onClick={onUnlink}>Unlink</button>}
          <button type="button" className="btn primary" disabled={!found} onClick={use}>Use this search</button>
        </div>
      </motion.div>
    </motion.div>
  )
}
