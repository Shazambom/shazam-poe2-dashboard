// poe.ninja price feed — inert. createTradeRequest never consults it; only the (unvendored)
// result-fetching code does.
'use strict'
const DivCurrency = { id: 'div', abbrev: 'div', ref: 'Divine Orb', text: 'Divine Orb', icon: '/images/div.png' }
const usePoeninja = () => ({ xchgRateCurrency: { value: undefined }, cachedCurrencyByQuery: () => undefined, selectedCoreCurrencyId: { value: 'exalted' }, availableCoreCurrencies: { value: [] } })
const displayRounding = (v) => v
module.exports = { DivCurrency, usePoeninja, displayRounding }
