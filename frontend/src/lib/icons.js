// Currency icon index. Every currency from /api/currencies carries an `icon` path
// on GGG's CDN (e.g. "/gen/image/…"). We reference those at runtime (a hotlink to
// GGG's own server) — nothing is bundled or re-hosted. Lets any view render a
// currency as its icon with the name on hover, keyed by trade id OR by name.
import { useEffect, useState } from 'react'
import { api } from './api.js'

export const CDN = 'https://web.poecdn.com'

let _index = null                 // { byId: Map<id,rec>, byName: Map<lcname,rec> }
let _promise = null
const subs = new Set()

const toUrl = (icon) => (!icon ? null : icon.startsWith('http') ? icon : CDN + icon)

export function loadIcons() {
  if (_index) return Promise.resolve(_index)
  if (_promise) return _promise
  _promise = api.currencies().then(d => {
    const items = Array.isArray(d) ? d : (d.currencies || d.items || [])
    const byId = new Map(), byName = new Map()
    for (const c of items) {
      const rec = { name: c.name, icon: toUrl(c.icon) }
      if (c.id) byId.set(c.id, rec)
      if (c.name) byName.set(c.name.toLowerCase(), rec)
    }
    _index = { byId, byName }
    subs.forEach(fn => { try { fn(_index) } catch {} })
    return _index
  }).catch(() => { _index = { byId: new Map(), byName: new Map() }; return _index })
  return _promise
}

// Resolve {id?, name?} -> { name, icon } or null. id wins, then name (case-insensitive).
export function lookup({ id, name } = {}) {
  if (!_index) return null
  if (id != null && _index.byId.has(id)) return _index.byId.get(id)
  if (name && _index.byName.has(String(name).toLowerCase())) return _index.byName.get(String(name).toLowerCase())
  return null
}

// Re-renders the caller once the index has loaded (returns the index or null).
export function useIcons() {
  const [idx, setIdx] = useState(_index)
  useEffect(() => {
    if (_index) { setIdx(_index); return }
    const fn = (i) => setIdx(i)
    subs.add(fn)
    loadIcons()
    return () => subs.delete(fn)
  }, [])
  return idx
}
