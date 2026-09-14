// Fuzzy smoke test for the Trading workspace STORE (the tree logic the UI is driven by).
//
// The workspace is meant to be owned entirely by the DB-backed store: the UI only reflects
// getState().tree + activeId. This test fuzzes that store — random unique-item forests put
// through random operation sequences, then cycled save -> rerender (hydrate) -> save 10x —
// and asserts nothing is ever lost or corrupted:
//   * every slug that hasn't been explicitly removed survives, with its immutable fields;
//   * save (persist payload) -> load (hydrate) -> render (getState) is byte-for-byte stable;
//   * ids stay unique; activeId always resolves to a real search node.
//
// Run:  node frontend/test/workspace-store.fuzzy.mjs
import assert from 'node:assert'

// The store's debounced persist() calls api.putWorkspace -> fetch. Stub fetch so it no-ops
// (and so we can capture the exact payload that WOULD hit the DB — the "saved" doc).
let lastSaved = null
globalThis.fetch = async (url, opts) => {
  if (typeof url === 'string' && url.includes('/api/trading/workspace') && opts?.method === 'PUT') {
    lastSaved = JSON.parse(opts.body).workspace
  }
  return { ok: true, status: 200, json: async () => ({ workspace: lastSaved }), text: async () => '' }
}

const { useWorkspace, searchNode, newFolder } = await import('../src/lib/workspaceStore.js')

// ---- deterministic RNG (seeded) so a failure reproduces exactly ----
let _s = 0x1234abcd
const rnd = () => { _s ^= _s << 13; _s ^= _s >>> 17; _s ^= _s << 5; return ((_s >>> 0) % 1e6) / 1e6 }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const chance = (p) => rnd() < p

const ITEMS = [
  'Headhunter Heavy Belt', 'Mageblood Heavy Belt', "Atziri's Acuity Moulded Mitts", 'The Pariah',
  'Original Sin', 'Melding of the Flesh', 'Sublime Vision', 'Progenesis Flask', 'Ashes of the Stars',
  'Bottled Faith', 'Nimis Topaz Ring', 'Defiance of Destiny', 'Dawnbreaker', 'Astramentis Amulet',
  'Ingenuity Belt', 'Polcirkeln Sapphire Ring', 'Sapphire Ring', 'Ruby Ring', 'Topaz Ring',
  'Stellar Amulet', 'Sorcerer Boots', 'Vaal Regalia', 'Advanced Wand', 'Expert Crossbow',
  'Divine Orb', 'Chaos Orb', 'Exalted Orb', 'Waystone Tier 15', 'Breach Ring', 'Simulacrum Splinter',
]
let itemCursor = 0
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const randSlug = () => 'H4sIAAAAAAAA' + Array.from({ length: 40 + Math.floor(rnd() * 120) }, () => pick([...B64])).join('')

// A search node with a UNIQUE item name + UNIQUE slug (the fuzz's "bunch of unique items").
function uniqueSearch() {
  const name = ITEMS[itemCursor % ITEMS.length] + ' #' + itemCursor
  itemCursor++
  const n = searchNode({ type: chance(0.2) ? 'search' : 'search', slug: randSlug(), live: chance(0.3) }, name)
  n.armed = chance(0.4); n.done = chance(0.3)
  return n
}

function randTree(depth, breadth) {
  const out = []
  const w = 1 + Math.floor(rnd() * breadth)
  for (let i = 0; i < w; i++) {
    if (depth > 0 && chance(0.4)) {
      const f = newFolder('Group ' + Math.floor(rnd() * 999))
      f.children = randTree(depth - 1, breadth)
      out.push(f)
    } else {
      out.push(uniqueSearch())
    }
  }
  return out
}

// ---- tree helpers (independent of the store, to validate it) ----
const walk = (nodes, fn) => (nodes || []).forEach(n => { fn(n); if (n.children) walk(n.children, fn) })
function slugMap(tree) { const m = new Map(); walk(tree, n => { if (n.kind === 'search') m.set(n.slug, n) }); return m }
function allIds(tree) { const ids = []; walk(tree, n => ids.push(n.id)); return ids }
function searchIds(tree) { const ids = []; walk(tree, n => { if (n.kind === 'search') ids.push(n.id) }); return ids }
function folderIds(tree) { const ids = []; walk(tree, n => { if (n.kind === 'folder') ids.push(n.id) }); return ids }
function findById(tree, id) { let hit = null; walk(tree, n => { if (n.id === id) hit = n }); return hit }
// All search slugs in a node's subtree (what a remove(node) actually deletes).
function subtreeSlugs(node) { const out = []; walk([node], n => { if (n.kind === 'search') out.push(n.slug) }); return out }

function clone(x) { return JSON.parse(JSON.stringify(x)) }

const store = useWorkspace.getState.bind(useWorkspace)

let treesRun = 0, cyclesRun = 0, opsRun = 0, totalNodes = 0

function runTree(t) {
  const tree = randTree(2 + Math.floor(rnd() * 3), 4)
  const sids = searchIds(tree)
  const doc = { version: 2, tree, layout: null, openTabs: [], activeId: sids.length ? pick(sids) : null }

  // Load it (this is what the UI renders from).
  store().hydrate(clone(doc))

  // Track the immutable identity of every original search by slug.
  const original = slugMap(store().tree)
  const originalCount = original.size
  const removed = new Set()

  for (let cycle = 0; cycle < 10; cycle++) {
    // --- apply a few random operations (the UI-driven mutations) ---
    const ops = 2 + Math.floor(rnd() * 4)
    for (let o = 0; o < ops; o++) {
      const s = store()
      const ids = allIds(s.tree)
      const sIds = searchIds(s.tree)
      const fIds = folderIds(s.tree)
      // Realistic drop targets: root (null) or a folder — mirrors react-arborist, which never
      // drops a node INTO a leaf search.
      const parent = () => (fIds.length && chance(0.6)) ? pick(fIds) : null
      const kind = pick(['addSearch', 'addFolder', 'rename', 'setField', 'move', 'toggleOpen', 'setActive', 'remove'])
      try {
        if (kind === 'addSearch') {
          const n = uniqueSearch()
          s.addSearch(parent(), { type: n.type, slug: n.slug, live: n.live }, n.name)
        } else if (kind === 'addFolder') {
          s.addFolder(parent())
        } else if (kind === 'rename' && ids.length) {
          s.rename(pick(ids), 'Renamed ' + Math.floor(rnd() * 999))
        } else if (kind === 'setField' && sIds.length) {
          s.setField(pick(sIds), { armed: chance(0.5), done: chance(0.5) })
        } else if (kind === 'move' && ids.length) {
          s.move(pick(ids), parent(), Math.floor(rnd() * 3))
        } else if (kind === 'toggleOpen' && ids.length) {
          s.toggleOpen(pick(ids))
        } else if (kind === 'setActive' && sIds.length) {
          s.setActive(pick(sIds))
        } else if (kind === 'remove' && ids.length > 1 && chance(0.5)) {
          const victim = pick(ids)   // may be a folder — its whole subtree goes
          const node = findById(s.tree, victim)
          if (node) subtreeSlugs(node).forEach(sl => removed.add(sl))
          s.remove(victim)
        }
      } catch (e) { throw new Error(`op ${kind} threw: ${e.message}`) }
      opsRun++
    }

    // --- save -> rerender (hydrate) -> save, and verify integrity ---
    const rendered = clone(store())                 // what the UI currently shows
    store().hydrate(clone(rendered))                // reload from a save (rerender)
    const reloaded = store()

    // 1) save/load is lossless
    assert.deepStrictEqual(reloaded.tree, rendered.tree, `tree drifted on cycle ${cycle}`)
    // 2) ids are unique (no accidental duplication from move/add)
    const ids = allIds(reloaded.tree)
    assert.strictEqual(new Set(ids).size, ids.length, `duplicate node id on cycle ${cycle}`)
    // 3) activeId (if set) resolves to a real search node
    if (reloaded.activeId != null) {
      assert.ok(searchIds(reloaded.tree).includes(reloaded.activeId), `activeId lost on cycle ${cycle}`)
    }
    // 4) every ORIGINAL search that wasn't removed still exists with its exact slug+type
    const now = slugMap(reloaded.tree)
    for (const [slug, on] of original) {
      if (removed.has(slug)) { assert.ok(!now.has(slug), `removed slug reappeared: ${slug}`); continue }
      const cur = now.get(slug)
      assert.ok(cur, `lost original search slug on cycle ${cycle}: ${slug}`)
      assert.strictEqual(cur.type, on.type, `type mutated for ${slug}`)
      assert.strictEqual(cur.slug, on.slug, `slug mutated for ${slug}`)
    }
    cyclesRun++
    totalNodes += allIds(reloaded.tree).length
  }
  // survivors = originals minus removed
  const survivors = slugMap(store().tree)
  for (const [slug] of original) if (!removed.has(slug)) assert.ok(survivors.has(slug), `final loss: ${slug}`)
  treesRun++
  void originalCount
}

for (let t = 0; t < 30; t++) runTree(t)

console.log(`OK: ${treesRun} fuzzy trees, ${cyclesRun} save/rerender cycles, ${opsRun} random ops, ` +
  `${totalNodes} node-checks — zero data loss, zero id collisions`)
process.exit(0)
