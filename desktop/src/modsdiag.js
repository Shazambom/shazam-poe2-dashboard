'use strict'
// TEMPORARY DEV DIAGNOSTIC (beta/dev only; installed behind diagTelemetryOn() in main.js).
// Reports, at 20s, 2m and 10m after launch, what the bundled backend holds for the Mods tab
// (pool and currency counts, the seed's snapshot version), where the league-history crawl is
// (phase, league, done/total) and what the renderer shows if the Mods tab is open (row and
// section counts, any empty-state text). Counts and phases only: no currency names, no user
// data. Loopback + the one telemetry sender; nothing else.
function install({ win, backendUrl, log }) {
  const j = async (path) => {
    try { return await (await fetch(`${backendUrl()}${path}`, { signal: AbortSignal.timeout(8000) })).json() } catch (e) { return { err: String(e).slice(0, 80) } }
  }
  const dom = async () => {
    try {
      return await win()?.webContents.executeJavaScript(`(() => {
        const m = document.querySelector('.mods'); if (!m) return 'closed'
        return JSON.stringify({ tables: m.querySelectorAll('.mods-table').length, rows: m.querySelectorAll('.mods-fam').length,
          sections: m.querySelectorAll('.mods-section').length, skel: m.querySelectorAll('.sk').length,
          empty: (m.querySelector('.empty,.hint')?.innerText || '').slice(0, 80), pool: document.querySelector('.mods-pool .curpick-input')?.value || '' })
      })()`, true)
    } catch (e) { return `dom-err ${String(e).slice(0, 60)}` }
  }
  const report = async (tag) => {
    if (!backendUrl()) { log(`${tag} backend not bound`); return }
    const [pools, bf, st] = await Promise.all([j('/api/mods/pools'), j('/api/backfill'), j('/api/status')])
    const mods = pools.err ? `err=${pools.err}` : `pools=${(pools.pools || []).length} currencies=${(pools.currencies || []).length}`
    const crawl = bf.err ? `err=${bf.err}` : `phase=${bf.phase} league=${JSON.stringify(bf.league)} ${bf.league_done}/${bf.league_total} leagues=${bf.leagues_done}/${bf.leagues_total}`
    const digest = st.err ? `err=${st.err}` : `behind_h=${st.digest?.behind_h} state=${st.digest?.state} backfilling=${st.digest?.backfilling} mod_pools_state=${JSON.stringify(st.mod_pools)}`
    log(`${tag} mods{${mods}} crawl{${crawl}} digest{${digest}} ui=${await dom()}`)
  }
  for (const [ms, tag] of [[20000, '@20s'], [120000, '@120s'], [600000, '@10m']]) setTimeout(() => report(tag).catch(() => {}), ms)
}
module.exports = { install }
