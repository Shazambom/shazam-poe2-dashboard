import React, { useEffect, useState } from 'react'
import { api, toast } from '../lib/api.js'
import { uid, searchFromParsed, tradeUrl, parseTradeUrl, openTrade } from '../lib/session.js'
import { useAutosave } from '../lib/hooks.js'

// Saved trade searches, Better-Trading style: folders → searches. We store only
// {type, slug} + title (never the league or query); the URL is rebuilt at open
// time with the current league. Opening just navigates the trade site — GGG runs
// the live search and you whisper by hand. Pure organiser, no automation.
export default function WatchesView({ league }) {
  const [folders, setFolders] = useState(null)
  const [addUrl, setAddUrl] = useState({})   // per-folder paste box
  const { state, save, arm } = useAutosave(f => api.putWatches(f))
  const desktop = typeof window !== 'undefined' && !!window.poe2desktop

  useEffect(() => {
    api.watches().then(d => { setFolders(d.folders || []); arm() }).catch(() => { setFolders([]); arm() })
  }, []) // eslint-disable-line

  const change = (fn) => setFolders(f => { const n = fn(f); save(n); return n })

  const addFolder = () => change(f => [...f, { id: uid(), title: 'New group', open: true, searches: [] }])
  const renameFolder = (fid, title) => change(f => f.map(x => x.id === fid ? { ...x, title } : x))
  const toggleFolder = (fid) => change(f => f.map(x => x.id === fid ? { ...x, open: !x.open } : x))
  const delFolder = (fid) => change(f => f.filter(x => x.id !== fid))

  const addSearch = (fid) => {
    const raw = (addUrl[fid] || '').trim()
    const parsed = parseTradeUrl(raw)
    if (!parsed) { toast('Paste a pathofexile.com/trade2 search link', false); return }
    change(f => f.map(x => x.id === fid ? { ...x, searches: [...x.searches, searchFromParsed(parsed)] } : x))
    setAddUrl(u => ({ ...u, [fid]: '' }))
  }
  const updSearch = (fid, sid, patch) => change(f => f.map(x => x.id === fid
    ? { ...x, searches: x.searches.map(s => s.id === sid ? { ...s, ...patch } : s) } : x))
  const delSearch = (fid, sid) => change(f => f.map(x => x.id === fid
    ? { ...x, searches: x.searches.filter(s => s.id !== sid) } : x))
  const open = (s, live) => {
    if (!league) { toast('No league set — pick one in the top bar', false); return }
    openTrade(tradeUrl(s, league, live))
  }

  if (!folders) return <div className="single hint">Loading watches…</div>
  const total = folders.reduce((n, f) => n + f.searches.length, 0)

  return (
    <div className="single watches">
      <div className="board-bar">
        <h2 style={{ margin: 0 }}>Watches <span className="muted" style={{ fontWeight: 400 }}>· {total} saved searches, opened in {league || '—'}</span>
          <span className="save-state">{state === 'saving' ? ' saving…' : state === 'saved' ? ' saved ✓' : ''}</span></h2>
        <span className="spacer" />
        <button className="btn" onClick={addFolder}>+ Group</button>
      </div>
      <p className="hint" style={{ marginTop: -6, marginBottom: 16 }}>
        Run a search on the trade site, copy its link, and paste it into a group below. Opening rebuilds it for the
        current league{desktop ? ' in a logged-in window' : ' in a new tab'} — GGG runs the live search, you whisper by hand.
      </p>

      {folders.length === 0 && <div className="empty">No groups yet. Add one, then paste trade-search links into it.</div>}

      {folders.map(f => (
        <div className="watch-folder" key={f.id}>
          <div className="wf-head">
            <button className="disclosure" onClick={() => toggleFolder(f.id)}>{f.open === false ? '▸' : '▾'}</button>
            <input className="wf-title" value={f.title} onChange={e => renameFolder(f.id, e.target.value)} />
            <span className="muted">{f.searches.length}</span>
            <span className="spacer" />
            <button className="btn small" onClick={() => delFolder(f.id)} title="Delete group">×</button>
          </div>
          {f.open !== false && (
            <div className="wf-body">
              {f.searches.map(s => (
                <div className={`watch-row ${s.done ? 'done' : ''}`} key={s.id}>
                  <input type="checkbox" checked={!!s.done} title="Mark done" onChange={e => updSearch(f.id, s.id, { done: e.target.checked })} />
                  <input className="ws-title" value={s.title} onChange={e => updSearch(f.id, s.id, { title: e.target.value })} />
                  <span className="ws-slug muted" title={`${s.type}/${s.slug}`}>{s.slug.slice(0, 8)}</span>
                  <span className="spacer" />
                  <button className="btn small" onClick={() => open(s, false)}>Open</button>
                  <button className="btn small primary" onClick={() => open(s, true)} title="GGG native live search">Live</button>
                  <button className="btn small" onClick={() => delSearch(f.id, s.id)} title="Remove">×</button>
                </div>
              ))}
              <div className="wf-add">
                <input className="btn" placeholder="Paste a trade-search link…" value={addUrl[f.id] || ''}
                  onChange={e => setAddUrl(u => ({ ...u, [f.id]: e.target.value }))}
                  onKeyDown={e => { if (e.key === 'Enter') addSearch(f.id) }} />
                <button className="btn small" onClick={() => addSearch(f.id)}>Add</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
