// One place that knows how to connect the PoE trade session, whichever shell
// we're running in. Both the top-bar button and the Settings panel use it.
//
//   * desktop app  → window.poe2desktop.connectSession() (Electron opens the
//                    login window and reads the HttpOnly cookie natively)
//   * plain browser → no bridge; caller falls back to paste / tools/connect.py
import { toast } from './api.js'

// The ONE "are we in the desktop app" predicate (and its trade-engine refinement).
export const isDesktop = typeof window !== 'undefined' && !!window.poe2desktop
export const hasTradeEngine = typeof window !== 'undefined' && !!window.poe2desktop?.trade

export const connectBridge = () => (isDesktop ? 'desktop' : null)   // 'desktop' | null

// Returns a promise resolving to { ok, message }. Never rejects.
export function connectSession() {
  const bridge = connectBridge()
  if (bridge === 'desktop') {
    return window.poe2desktop.connectSession()
      .then(r => r || { ok: false, message: 'no response' })
      .catch(e => ({ ok: false, message: String(e.message || e) }))
  }
  return Promise.resolve({ ok: false, message: 'no bridge' })
}

// --- trade searches -------------------------------------------------------
const TRADE_BASE = 'https://www.pathofexile.com/trade2'

export const uid = () => Math.random().toString(36).slice(2, 9)

// The trade search page for a league (the Trade tab's home). PoE2 URLs carry a `poe2`
// realm segment: /trade2/search/poe2/{league}[/{slug}].
export const tradeHome = (league) => `${TRADE_BASE}/search/poe2/${encodeURIComponent(league || 'Standard')}`

// Reconstruct a trade-search URL from a stored {type, slug}, injecting the league
// at open time (never stored). live=true → GGG's native live search.
export function tradeUrl({ type, slug }, league, live) {
  const u = `${TRADE_BASE}/${type || 'search'}/poe2/${encodeURIComponent(league)}/${slug}`
  return live ? `${u}/live` : u
}

// Parse a trade URL into { type, slug, live } (league is read but dropped). Looks at the
// PATHNAME only — a `?q=<json>` link has no slug and must never yield one (the JSON can
// contain '/'). Handles the PoE2 realm segment /trade2/{type}/poe2/{league}/{slug}[/live]
// and the older realm-less /trade2/{type}/{league}/{slug}. Mirrored byte-for-byte in
// desktop/src/trade/urls.js (main classifies the clipboard); a desktop test pins parity.
export function parseTradeUrl(url) {
  let pathname
  try { pathname = new URL(String(url), TRADE_BASE).pathname } catch { return null }
  // With the realm segment the league AND slug must both follow it; without it, league + slug.
  const m = pathname.match(/\/trade2?\/([a-z]+)\/poe2\/[^/]+\/([^/]+?)(\/live)?\/?$/i)
    || pathname.match(/\/trade2?\/([a-z]+)\/(?!poe2\/)[^/]+\/([^/]+?)(\/live)?\/?$/i)
  if (!m) return null
  return { type: m[1], slug: m[2], live: !!m[3] }
}

// Parse an EE2-style query link — /trade2/search/poe2/{league}?q=<json> — into { q } where q is
// the exact JSON string (validated, never re-serialised). Exchange links and non-JSON → null.
export function parseTradeQueryUrl(url) {
  let u
  try { u = new URL(String(url), TRADE_BASE) } catch { return null }
  if (!/\/trade2?\/search\/(?:poe2\/)?[^/]+\/?$/i.test(u.pathname)) return null
  const q = u.searchParams.get('q')
  if (!q) return null
  try { const j = JSON.parse(q); if (!j || typeof j !== 'object') return null } catch { return null }
  return { q }
}

// A query link for a stored { q }, league injected at open time (never stored). Both parts are
// percent-encoded; the site decodes to the same bytes EE2 interpolates raw.
export const queryUrl = ({ q }, league) => `${TRADE_BASE}/search/poe2/${encodeURIComponent(league || 'Standard')}?q=${encodeURIComponent(q)}`

// Open a trade search — a real logged-in window in the desktop app, a new tab in a
// browser. Human then reads results and whispers manually.
export function openTrade(url) {
  if (typeof window !== 'undefined' && window.poe2desktop?.openTrade) window.poe2desktop.openTrade(url)
  else window.open(url, '_blank', 'noopener')
}

// Convenience for the top bar: connect, toast the result, run onDone on success.
export async function connectSessionWithToast(onDone) {
  const r = await connectSession()
  toast(r.message, r.ok !== false)
  if (r.ok) onDone?.()
  return r
}
