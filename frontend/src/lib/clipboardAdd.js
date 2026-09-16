import { useWorkspace } from './workspaceStore.js'
import { toast } from './api.js'
import { diag } from './diag.js'

// Clipboard-add (roadmap §7 1-D): ask main to classify the clipboard (the text never reaches us),
// then walk the ladder. `targetId` = the folder the new node should land in (null → root; the
// history folder is refused by the store). Returns the telemetry result string.
export async function addFromClipboard(targetId = null) {
  const bridge = typeof window !== 'undefined' ? window.poe2desktop?.clipboard : null
  if (!bridge) { toast('Add from clipboard runs in the desktop app', false); return 'no-desktop' }
  let cls
  try { cls = await bridge.classify() } catch { cls = { kind: 'none', len: 0 } }
  const st = useWorkspace.getState()
  const done = (result, extra = '') => { diag('ee2', `clipboard-add result=${result}${extra}`); return result }
  switch (cls?.kind) {
    case 'trade-url': {
      const p = cls.parsed
      const r = st.ingest({ source: 'clipboard', slug: p.slug, type: p.type, live: p.live, name: `Search ${String(p.slug).slice(0, 6)}`, folder: null, targetId })
      if (r.result === 'dup') { toast('Already saved — selected it'); return done('dup', ' src=url') }
      if (r.result !== 'added') { toast('Could not add right now', false); return done('dropped', ' src=url') }
      return done('ok', ' src=url')
    }
    case 'query-url': {
      const q = cls.parsed.q
      const r = st.ingest({ source: 'clipboard', q, name: nameFromQuery(q), folder: null, targetId })
      if (r.result === 'dup') { toast('Already saved — selected it'); return done('dup', ' src=query-url') }
      if (r.result !== 'added') { toast('Could not add right now', false); return done('dropped', ' src=query-url') }
      return done('ok', ' src=query-url')
    }
    case 'exchange': toast("Bulk exchange links aren't saved here — use the Board", false); return done('exchange')
    case 'item': return done('invalid', ' src=item')   // the builder lands in batch 3
    default:
      if (!cls || !cls.len) { toast('Clipboard is empty', false); return done('empty') }
      toast("That's not a trade link", false); return done('invalid', ` len=${cls.len}`)
  }
}

// A display name from an EE2 query: "<name> <type>" when both exist, else whichever is set.
export function nameFromQuery(q) {
  try {
    const j = JSON.parse(q)
    const qq = j?.query || {}
    const parts = [qq.name, qq.type].filter(x => typeof x === 'string' && x.trim())
    if (parts.length) return parts.join(' ').slice(0, 60)
    const t = qq.type && typeof qq.type === 'object' ? qq.type.option : null
    if (t) return t
    // No item name (a rare/magic query): name it by the trade category, e.g. accessory.ring → "Ring query".
    const cat = qq.filters?.type_filters?.filters?.category?.option
    if (typeof cat === 'string' && cat) { const last = cat.split('.').pop().replace(/_/g, ' '); return `${last.charAt(0).toUpperCase()}${last.slice(1)} query` }
    return 'Query search'
  } catch { return 'Query search' }
}
