// Clipboard-add classification, run in MAIN so the clipboard text never crosses into the renderer
// (roadmap §4.7). classify(text) is pure; main reads the clipboard once and classifies that. Returns
// only a classification: { kind: 'trade-url' | 'query-url' | 'exchange' | 'none' … }. The 'item'
// rung is the PoE item text itself: main asks the history consumer's worker for the query (batch 4-A).
'use strict'
const { parseTradeUrl, parseTradeQueryUrl, isExchangeUrl } = require('./trade/urls.js')
const { looksLikeItem } = require('./integrations/exiled-exchange/clipboard-watcher.js')

const MAX_CLIP = 8000

// A pathofexile.com link copied out of a wrapped chat or terminal carries line breaks and spaces; a
// URL never holds raw whitespace, so a clipboard that STARTS with one is read with them removed.
const POE_LINK = /^https?:\/\/(www\.)?pathofexile\.com\//i

function classify(raw) {
  let text = String(raw || '').slice(0, MAX_CLIP).trim()
  if (!text) return { kind: 'none', len: 0 }
  if (POE_LINK.test(text)) text = text.replace(/\s+/g, '')
  if (isExchangeUrl(text)) return { kind: 'exchange' }
  const p = parseTradeUrl(text)
  if (p && p.slug) return { kind: 'trade-url', parsed: p }
  const q = parseTradeQueryUrl(text)
  if (q) return { kind: 'query-url', parsed: q }
  if (looksLikeItem(text)) return { kind: 'item' }   // main builds the intent via the history consumer's worker
  return { kind: 'none', len: text.length }
}

module.exports = { MAX_CLIP, classify }
