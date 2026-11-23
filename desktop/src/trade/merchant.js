// Stash → Merchant: fetch the player's own active Instant Buyout listings through their logged-in
// session under the shared rate budget with spare: 0.5 headroom so live search always keeps half
// of every rate window. Manual refresh only; cancellable on tab leave or league switch.
'use strict'
const {
  makeRechecker,
  waitedBudgeted,
  defaultWait,
  CANCELLED,
  LISTING_ID,
  SEARCH_ID,
  SPARE,
  SEARCH_POLICY,
  FETCH_POLICY,
} = require('./listings.js')
const { lookupItemMods } = require('./modsearch.js')
const { TRADE_BASE, FETCH_MAX, INSTANT_BUYOUT } = require('./urls.js')

const MAX_SHOP_ITEMS = 50
const MAX_ACCOUNT_LEN = 80
const CURSOR_TTL_MS = 5 * 60_000
const MAX_CURSORS = 8
const SORT_SPEC = {
  price_desc: { price: 'desc' },
  oldest: { indexed: 'asc' },
}

const FRAME_RARITY = { 0: 'Normal', 1: 'Magic', 2: 'Rare', 3: 'Unique', 4: 'Gem', 5: 'Currency', 6: 'Divination', 8: 'Prophecy', 9: 'Relic' }
const ITEM_KEYS = [
  'name', 'typeLine', 'baseType', 'rarity', 'frameType', 'icon', 'ilvl',
  'corrupted', 'mirrored', 'identified', 'properties', 'requirements',
  'enchantMods', 'runeMods', 'implicitMods', 'explicitMods', 'craftedMods', 'fracturedMods',
]

function projectItem(it) {
  if (!it || typeof it !== 'object') return {}
  const out = {}
  for (const k of ITEM_KEYS) if (it[k] !== undefined) out[k] = it[k]
  return out
}

function resolveModsSafe(it, rarity) {
  if (rarity !== 'Rare') return null
  try { return lookupItemMods(it) } catch { return null }
}

// Keep ONLY shop display fields — strip whisper, whisper_token, hideout_token, and account block.
function projectShopRows(json) {
  return (Array.isArray(json?.result) ? json.result : [])
    .filter(x => typeof x?.id === 'string' && Number.isFinite(x.listing?.price?.amount) && typeof x.listing.price.currency === 'string')
    .map(x => {
      const it = x.item && typeof x.item === 'object' ? x.item : {}
      const rarity = typeof it.rarity === 'string' && it.rarity ? it.rarity : (FRAME_RARITY[it.frameType] || '')
      const matchedMods = resolveModsSafe(it, rarity)
      return {
        id: x.id,
        indexed: typeof x.listing?.indexed === 'string' ? x.listing.indexed : null,
        amount: x.listing.price.amount,
        currency: x.listing.price.currency,
        name: typeof it.name === 'string' ? it.name : '',
        typeLine: typeof it.typeLine === 'string' ? it.typeLine : '',
        baseType: typeof it.baseType === 'string' ? it.baseType : '',
        rarity,
        icon: typeof it.icon === 'string' ? it.icon : null,
        ilvl: Number.isFinite(it.ilvl) ? it.ilvl : null,
        note: typeof it.note === 'string' ? it.note : (typeof x.listing?.note === 'string' ? x.listing.note : ''),
        stashName: typeof x.listing?.stash?.name === 'string' ? x.listing.stash.name : '',
        item: projectItem(it),
        ...(matchedMods ? { matchedMods } : {}),
      }
    })
}

function batchFailure(res, signal) {
  if (signal.aborted || res.error === 'cancelled') return CANCELLED
  if (!res.ok && !(res.error === 'rate' && res.rows.length > 0)) {
    return { ok: false, error: res.error, status: res.status, retryAfter: res.retryAfter }
  }
  return null
}

// Extract "Name#1234" from /my-account HTML profile link.
function parseProfileAccount(html) {
  if (typeof html !== 'string' || !html) return ''
  const m = html.match(/\/account\/view-profile\/([^"'?#<>\s]+)/i)
  if (!m) return ''
  let slug = m[1]
  try { slug = decodeURIComponent(slug) } catch {}
  slug = slug.trim().replace(/-(\d{4})$/, '#$1')
  return slug.length > 0 && slug.length <= MAX_ACCOUNT_LEN ? slug : ''
}

function raceAbort(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve(CANCELLED)
  return new Promise((resolve) => {
    const onAbort = () => resolve(CANCELLED)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(signal.aborted ? CANCELLED : v) },
      (e) => { signal.removeEventListener('abort', onAbort); resolve(signal.aborted ? CANCELLED : { ok: false, error: String(e?.message || e) }) },
    )
  })
}

function pageResponse({ account, total, idsLen, offset, sortKey, res, fetchedAt, cursorStartAt }) {
  const remainingIds = Math.max(0, idsLen - offset)
  const apiCapReached = total > idsLen && remainingIds === 0
  return {
    ok: true,
    account,
    total,
    truncated: total > offset,
    remainingIds,
    apiCapReached,
    sort: sortKey,
    rows: res.rows,
    fetchedAt,
    cursorExpiresAt: remainingIds > 0 ? cursorStartAt + CURSOR_TTL_MS : null,
    ...(res.ok ? {} : { partial: true, rateLimited: true }),
  }
}

function makeMerchantFetcher({ request, budget, log = () => {}, wait = defaultWait, now = Date.now }) {
  const deps = { request, budget }
  let drop = new AbortController()
  const inFlight = new Map()
  const cursors = new Map()   // `${lg}|${acctLower}|${sort}` -> { searchId, ids, total, offset, at, gen }
  let nextGen = 1
  let accountGen = 1
  let cachedAccount = null    // logged-in PoE account resolved from active desktop session
  let resolvingAccount = null // { gen, promise }

  function pruneCursors(t) {
    for (const [k, c] of cursors) if (t - c.at > CURSOR_TTL_MS) cursors.delete(k)
    while (cursors.size > MAX_CURSORS) {
      const oldestKey = cursors.keys().next().value
      cursors.delete(oldestKey)
    }
  }

  async function resolveSessionAccount(signal) {
    if (signal?.aborted) return CANCELLED
    if (cachedAccount) return { ok: true, account: cachedAccount }
    if (!resolvingAccount || resolvingAccount.gen !== accountGen) {
      const gen = accountGen
      const promise = (async () => {
        try {
          const r = await request({
            method: 'GET',
            path: '/my-account',
            referer: 'https://www.pathofexile.com/',
            accept: 'text/html,application/xhtml+xml',
            xhr: false,
          })
          if (r?.status === 401 || r?.status === 403) return { ok: false, error: 'auth', status: r.status }
          const parsed = r?.status >= 200 && r?.status < 300 ? parseProfileAccount(r.body) : ''
          if (parsed) {
            if (gen === accountGen) cachedAccount = parsed
            return { ok: true, account: parsed }
          }
          return { ok: false, error: 'auth' }
        } catch (e) {
          return { ok: false, error: String(e?.message || e) }
        }
      })().finally(() => {
        if (resolvingAccount && resolvingAccount.promise === promise) resolvingAccount = null
      })
      resolvingAccount = { gen, promise }
    }
    const res = await raceAbort(resolvingAccount.promise, signal)
    if (signal?.aborted) return CANCELLED
    return res
  }

  async function fetchBatches(home, searchId, batchIds, signal) {
    const rows = []
    let consumed = 0
    for (let i = 0; i < batchIds.length; i += FETCH_MAX) {
      if (signal.aborted) return { ok: false, error: 'cancelled', rows, consumed }
      const batch = batchIds.slice(i, i + FETCH_MAX)
      const f = await waitedBudgeted(deps, FETCH_POLICY, {
        method: 'GET',
        path: `/api/trade2/fetch/${batch.join(',')}?query=${searchId}&realm=poe2`,
        referer: `${home}/${searchId}`,
      }, signal, wait, { spare: SPARE })
      if (!f.ok) {
        log(`merchant status=${f.status ?? f.error} step=fetch`)
        return { ok: false, error: f.error, status: f.status, retryAfter: f.retryAfter, rows, consumed }
      }
      rows.push(...projectShopRows(f.data))
      consumed += batch.length
    }
    return { ok: true, rows, consumed }
  }

  async function fetchShop({ league, account, sort = 'price_desc', more = false } = {}) {
    const lg = String(league ?? '').trim()
    const rawAcct = account == null ? '' : String(account).trim()
    const sortKey = Object.prototype.hasOwnProperty.call(SORT_SPEC, sort) ? sort : 'price_desc'
    const isMore = !!more
    if (!lg || rawAcct.length > MAX_ACCOUNT_LEN) return { ok: false, error: 'bad request' }

    const signal = drop.signal
    const startAccountGen = accountGen
    let acct = rawAcct
    if (!acct) {
      const resolved = await resolveSessionAccount(signal)
      if (!resolved.ok) return resolved
      if (signal.aborted || accountGen !== startAccountGen) return CANCELLED
      acct = resolved.account
    }

    const cursorKey = `${lg}|${acct.toLowerCase()}|${sortKey}`
    const flightKey = `${cursorKey}|${isMore ? 'more' : 'head'}`
    if (inFlight.has(flightKey)) return inFlight.get(flightKey)
    const p = (isMore ? runMore(lg, acct, cursorKey, sortKey, signal) : runFresh(lg, acct, cursorKey, sortKey, signal, startAccountGen))
      .finally(() => { if (inFlight.get(flightKey) === p) inFlight.delete(flightKey) })
    inFlight.set(flightKey, p)
    return p
  }

  async function runFresh(lg, acct, cursorKey, sortKey, signal, startAccountGen) {
    const gen = nextGen++
    const home = `${TRADE_BASE}/search/poe2/${encodeURIComponent(lg)}`
    const body = {
      query: {
        status: INSTANT_BUYOUT,
        filters: { trade_filters: { filters: { account: { input: acct } } } },
      },
      sort: SORT_SPEC[sortKey],
    }
    const s = await waitedBudgeted(deps, SEARCH_POLICY, {
      method: 'POST',
      path: `/api/trade2/search/poe2/${encodeURIComponent(lg)}`,
      body,
      referer: home,
    }, signal, wait, { spare: SPARE })
    if (!s.ok) {
      if (s.error === 'auth') cachedAccount = null
      log(`merchant status=${s.status ?? s.error} step=search`)
      return s
    }

    const searchId = s.data?.id
    const ids = Array.isArray(s.data?.result) ? s.data.result.filter(i => LISTING_ID.test(String(i))) : []
    const total = Number.isFinite(Number(s.data?.total)) ? Number(s.data.total) : ids.length
    const fetchedAt = now()
    if (!searchId || !SEARCH_ID.test(String(searchId)) || !ids.length) {
      if (accountGen === startAccountGen) cursors.delete(cursorKey)
      log(`merchant status=200 total=${total} rows=0`)
      return {
        ok: true,
        account: acct,
        total,
        truncated: total > 0,
        remainingIds: 0,
        apiCapReached: false,
        sort: sortKey,
        rows: [],
        fetchedAt,
        cursorExpiresAt: null,
      }
    }

    const take = ids.slice(0, MAX_SHOP_ITEMS)
    const res = await fetchBatches(home, searchId, take, signal)
    const fail = batchFailure(res, signal)
    if (fail) {
      if (fail.error === 'auth') cachedAccount = null
      return fail
    }
    if (accountGen !== startAccountGen) return CANCELLED

    const offset = res.consumed
    const at = now()
    pruneCursors(at)
    const existing = cursors.get(cursorKey)
    if (!existing || existing.gen < gen) {
      cursors.set(cursorKey, { searchId, ids, total, offset, at, gen })
    }
    log(`merchant status=200 total=${total} rows=${res.rows.length} sort=${sortKey}${res.ok ? '' : ' partial=1'}`)
    return pageResponse({ account: acct, total, idsLen: ids.length, offset, sortKey, res, fetchedAt: at, cursorStartAt: at })
  }

  async function runMore(lg, acct, cursorKey, sortKey, signal) {
    const t = now()
    const cur = cursors.get(cursorKey)
    if (!cur || t - cur.at > CURSOR_TTL_MS) {
      cursors.delete(cursorKey)
      return { ok: false, error: 'expired' }
    }
    if (cur.offset >= cur.ids.length) {
      return pageResponse({
        account: acct,
        total: cur.total,
        idsLen: cur.ids.length,
        offset: cur.offset,
        sortKey,
        res: { ok: true, rows: [] },
        fetchedAt: t,
        cursorStartAt: cur.at,
      })
    }

    const expectedGen = cur.gen
    const home = `${TRADE_BASE}/search/poe2/${encodeURIComponent(lg)}`
    const take = cur.ids.slice(cur.offset, cur.offset + MAX_SHOP_ITEMS)
    const res = await fetchBatches(home, cur.searchId, take, signal)
    const fail = batchFailure(res, signal)
    if (fail) {
      if (fail.error === 'auth') cachedAccount = null
      return fail
    }

    const latest = cursors.get(cursorKey)
    if (!latest || latest.gen !== expectedGen) return CANCELLED
    latest.offset += res.consumed
    const doneAt = now()
    log(`merchant status=200 more=1 total=${latest.total} rows=${res.rows.length} offset=${latest.offset}`)
    return pageResponse({
      account: acct,
      total: latest.total,
      idsLen: latest.ids.length,
      offset: latest.offset,
      sortKey,
      res,
      fetchedAt: doneAt,
      cursorStartAt: latest.at,
    })
  }

  // Abort active requests without wiping valid pagination cursors so tab switches preserve Load next 50.
  fetchShop.cancel = () => { drop.abort(); drop = new AbortController(); inFlight.clear() }
  // Clear cached session account, invalidate any in-flight account resolution, and wipe cursors on login/logout/cookie change.
  fetchShop.resetAccount = () => { accountGen++; cachedAccount = null; resolvingAccount = null; cursors.clear() }
  return fetchShop
}

// Merchant-scoped inline floor pricer: thin adapter over makeRechecker (desktop/src/trade/listings.js)
// with spare: 0.5 headroom and keepOnRate: true, so Merchant gets the exact same deeper-rank sampling
// (beating GGG's broken Exalted-Equivalent sort), in-flight dedup, and 5-min kept-search retry as Workspace.
function makeMerchantPricer({ request, budget, log = () => {}, wait = defaultWait, now = Date.now }) {
  const recheck = makeRechecker({ request, budget, log, wait, spare: SPARE, keepOnRate: true, tag: 'merchant-price', now })
  async function priceCheck({ league, query } = {}) {
    const lg = String(league ?? '').trim()
    if (!lg || !query?.query || typeof query.query !== 'object' || Array.isArray(query.query)) {
      return { ok: false, error: 'bad request' }
    }
    const res = await recheck({ league: lg, query: query.query })
    if (!res.ok) return res
    const listings = (res.rows || [])
      .filter(p => Number.isFinite(p.amount) && p.amount > 0 && typeof p.currency === 'string')
      .map(({ amount, currency }) => ({ amount, currency }))
    return { ok: true, searchId: res.searchId, total: res.total || listings.length, listings, rows: res.rows }
  }
  priceCheck.cancel = () => recheck.cancel()
  return priceCheck
}

module.exports = {
  projectShopRows,
  parseProfileAccount,
  makeMerchantFetcher,
  makeMerchantPricer,
  MAX_SHOP_ITEMS,
  CURSOR_TTL_MS,
  SPARE,
  SEARCH_POLICY,
  FETCH_POLICY,
}
