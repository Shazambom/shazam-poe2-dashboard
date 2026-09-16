// Clipboard-add classification, run in MAIN so the clipboard text never crosses into the renderer
// (roadmap §4.7). classify(text) is pure; classifyClipboard(readText) wraps the reader. Returns
// only a classification: { kind: 'trade-url' | 'query-url' | 'exchange' | 'none' … }. The 'item'
// rung (an EE2-parsed item) arrives with the batch-3 builder; until then item text is 'none'.
'use strict'
const { parseTradeUrl, parseTradeQueryUrl, isExchangeUrl } = require('./trade/urls.js')

const MAX_CLIP = 8000

function classify(raw) {
  const text = String(raw || '').slice(0, MAX_CLIP).trim()
  if (!text) return { kind: 'none', len: 0 }
  if (isExchangeUrl(text)) return { kind: 'exchange' }
  const p = parseTradeUrl(text)
  if (p && p.slug) return { kind: 'trade-url', parsed: p }
  const q = parseTradeQueryUrl(text)
  if (q) return { kind: 'query-url', parsed: q }
  return { kind: 'none', len: text.length }
}

function classifyClipboard(readText) {
  let text = ''
  try { text = String(readText() || '') } catch { text = '' }
  return classify(text.slice(0, MAX_CLIP))
}

module.exports = { MAX_CLIP, classify, classifyClipboard }
