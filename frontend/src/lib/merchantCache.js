export const shopCache = new Map()      // `${league}|${acctLower}|${sort}` -> shop snapshot (FIFO max 10)
export const marketCache = new Map()    // league -> { prices, inflation, sales, fetchedAt }
export const marketInFlight = new Map() // league -> Promise<market | null>
export const priceCache = new Map()     // `${league}|${floorQuery}` -> { res, at } (FIFO max 200)

export function clearMerchantShopCache() {
  shopCache.clear()
}

export function _resetMerchantCache() {
  shopCache.clear()
  marketCache.clear()
  marketInFlight.clear()
  priceCache.clear()
}
