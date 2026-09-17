// Currency icon index. Every currency from /api/currencies carries an `icon` path
// on GGG's CDN (e.g. "/gen/image/…"). We reference those at runtime (a hotlink to
// GGG's own server) — nothing is bundled or re-hosted. Lets any view render a
// currency as its icon with the name on hover, keyed by trade id OR by name.
import { useEffect, useState } from 'react'
import { api } from './api.js'

export const CDN = 'https://web.poecdn.com'

let _index = null                 // { byId: Map<id,rec>, byName: Map<lcname,rec>, raw, list }
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
    _index = { byId, byName, raw: d, list: items }
    subs.forEach(fn => { try { fn(_index) } catch {} })
    if (!d.loaded_at) retrySoon()       // backend hasn't fetched names/icons yet — it retries, so do we
    return _index
  }).catch(() => { _index = { byId: new Map(), byName: new Map(), raw: null, list: [] }; retrySoon(); return _index })
  return _promise
}

// The index is fetched once and kept; a load that came back incomplete (or failed) is re-asked
// every 30 s until the backend has the real thing, then every subscriber re-renders.
function retrySoon() {
  setTimeout(() => {
    const keep = _index
    _index = null; _promise = null
    loadIcons().then(i => { if (!i.list.length && keep?.list.length) _index = keep })
  }, 30000)
}

// The ONE /api/currencies fetch, as a store: `raw` (the payload, incl. anchors + unmapped ids),
// `list` (the currency records), `byId`, and `nameOf(id)`. Every view that used to fetch its own
// copy reads this instead.
export function useCurrencies() {
  const idx = useIcons()
  return {
    raw: idx?.raw ?? null,
    list: idx?.list ?? [],
    byId: idx?.byId ?? new Map(),
    nameOf: (id) => idx?.byId.get(id)?.name || id,
  }
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
    const fn = (i) => setIdx(i)
    subs.add(fn)                       // always: a later reload (retrySoon) must reach this caller too
    if (_index) setIdx(_index); else loadIcons()
    return () => subs.delete(fn)
  }, [])
  return idx
}
