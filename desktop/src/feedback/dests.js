// The screens the feedback sweep photographs — a CommonJS twin of frontend/src/lib/dests.js (the
// renderer's ESM list; Electron's main process cannot require it). Pinned equal by
// desktop/test/feedback-dests-sync.test.mjs, together with the opener's allow-list.
'use strict'
const DESTS = [
  { id: 'board', section: 'Board', sub: null },
  { id: 'strategy-hold', section: 'Strategy', sub: 'hold' },
  { id: 'strategy-arbitrage', section: 'Strategy', sub: 'arbitrage' },
  { id: 'economy-inflation', section: 'Economy', sub: 'inflation' },
  { id: 'economy-market', section: 'Economy', sub: 'market' },
  { id: 'trading-workspace', section: 'Trading', sub: 'workspace' },
  { id: 'trading-live', section: 'Trading', sub: 'live' },
  { id: 'trading-sales', section: 'Trading', sub: 'sales' },
  { id: 'settings', section: 'Settings', sub: null },
]
module.exports = { DESTS }
