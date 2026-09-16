// EE2's useTradeData() served from the release-time snapshot (data/trade/{items,stats}.json) —
// the same shapes TradeData.ts derives from GGG's /api/trade2/data endpoints, no fetch.
'use strict'
const fs = require('fs'), path = require('path')
let dataDir = null
function setDataDir(d) { dataDir = d }
function derive() {
  const items = JSON.parse(fs.readFileSync(path.join(dataDir, 'trade', 'items.json'), 'utf8'))
  const stats = JSON.parse(fs.readFileSync(path.join(dataDir, 'trade', 'stats.json'), 'utf8'))
  const itemData = new Set()
  for (const cat of items.result) for (const { type, text } of cat.entries) { if (type) itemData.add(type); if (text) itemData.add(text) }
  const statData = new Map(), statDataSet = new Set()
  for (const { id: modType, entries } of stats.result) for (const { id, text } of entries) {
    let m = statData.get(text); if (!m) { m = {}; statData.set(text, m) }
    ;(m[modType] ||= []).push(id); statDataSet.add(id)
  }
  return { itemData, statData, statDataSet }
}
let state = null
function useTradeData() {
  if (state) return state
  const holder = { isLoading: { value: false }, error: { value: null }, tradeItemData: { value: new Set() }, tradeStatData: { value: new Map() }, tradeStatDataSet: { value: new Set() },
    async load() { const d = derive(); holder.tradeItemData.value = d.itemData; holder.tradeStatData.value = d.statData; holder.tradeStatDataSet.value = d.statDataSet; return { foundItems: d.itemData.size, foundStats: d.statDataSet.size } },
    expressInterest() {} }
  state = holder
  return state
}
module.exports = { useTradeData, setDataDir }
