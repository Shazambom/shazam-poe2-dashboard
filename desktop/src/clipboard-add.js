// Clipboard-add classification, run in MAIN so the clipboard text never crosses into the renderer
// (roadmap §4.7). classify(text) is pure; classifyClipboard(readText) wraps the reader. Returns
// only a classification: { kind: 'trade-url' | 'query-url' | 'exchange' | 'none' … }. The 'item'
// rung is the PoE item text itself: main asks the history consumer's worker for the query (batch 4-A).
'use strict'
const { parseTradeUrl, parseTradeQueryUrl, isExchangeUrl } = require('./trade/urls.js')
const { looksLikeItem } = require('./integrations/exiled-exchange/clipboard-watcher.js')

const MAX_CLIP = 8000

function classify(raw) {
  const text = String(raw || '').slice(0, MAX_CLIP).trim()
  if (!text) return { kind: 'none', len: 0 }
  if (isExchangeUrl(text)) return { kind: 'exchange' }
  const p = parseTradeUrl(text)
  if (p && p.slug) return { kind: 'trade-url', parsed: p }
  const q = parseTradeQueryUrl(text)
  if (q) return { kind: 'query-url', parsed: q }
  if (looksLikeItem(text)) return { kind: 'item' }   // main builds the intent via the history consumer's worker
  return { kind: 'none', len: text.length }
}

function classifyClipboard(readText) {
  let text = ''
  try { text = String(readText() || '') } catch { text = '' }
  return classify(text.slice(0, MAX_CLIP))
}

module.exports = { MAX_CLIP, classify, classifyClipboard }
