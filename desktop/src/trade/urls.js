// Trade-URL helpers for the MAIN process (clipboard classification). This is the CommonJS twin
// of frontend/src/lib/session.js — Electron 33's Node cannot require an ES module, so the two
// copies are pinned identical by desktop/test/clipboard-add.test.mjs. Change both together.
'use strict'
const TRADE_BASE = 'https://www.pathofexile.com/trade2'

const tradeHome = (league) => `${TRADE_BASE}/search/poe2/${encodeURIComponent(league || 'Standard')}`

function tradeUrl({ type, slug }, league, live) {
  const u = `${TRADE_BASE}/${type || 'search'}/poe2/${encodeURIComponent(league)}/${slug}`
  return live ? `${u}/live` : u
}

function parseTradeUrl(url) {
  let pathname
  try { pathname = new URL(String(url), TRADE_BASE).pathname } catch { return null }
  // With the realm segment the league AND slug must both follow it; without it, league + slug.
  const m = pathname.match(/\/trade2?\/([a-z]+)\/poe2\/[^/]+\/([^/]+?)(\/live)?\/?$/i)
    || pathname.match(/\/trade2?\/([a-z]+)\/(?!poe2\/)[^/]+\/([^/]+?)(\/live)?\/?$/i)
  if (!m) return null
  return { type: m[1], slug: m[2], live: !!m[3] }
}

function parseTradeQueryUrl(url) {
  let u
  try { u = new URL(String(url), TRADE_BASE) } catch { return null }
  if (!/\/trade2?\/search\/(?:poe2\/)?[^/]+\/?$/i.test(u.pathname)) return null
  const q = u.searchParams.get('q')
  if (!q) return null
  try { const j = JSON.parse(q); if (!j || typeof j !== 'object') return null } catch { return null }
  return { q }
}

const queryUrl = ({ q }, league) => `${TRADE_BASE}/search/poe2/${encodeURIComponent(league || 'Standard')}?q=${encodeURIComponent(q)}`

const isExchangeUrl = (url) => { try { return /\/trade2?\/exchange\//i.test(new URL(String(url), TRADE_BASE).pathname) } catch { return false } }

module.exports = { TRADE_BASE, tradeHome, tradeUrl, parseTradeUrl, parseTradeQueryUrl, queryUrl, isExchangeUrl }
