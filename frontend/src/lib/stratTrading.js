// Strat Calculator → Trading: open a linked search on the Trading tab, selecting the saved search with
// the same filters or adding it to a "From strats" folder (owner, 2026-10-01). Filters are the same
// whatever their key order or how the row was saved (a ?q= row or a saved slug, read from the link);
// the sort is not a filter. The History folder is the automatic log, never a match. Nothing is written
// before the workspace has loaded: an early write would replace the saved tree.
import { savedSearches, searchOfNode } from './workspaceStore.js'
import { canon } from './canon.js'

export const FROM_STRATS = 'From strats'

async function sameSearch(tree, query, league) {
  const want = canon(query.query)
  for (const { node } of savedSearches(tree)) {
    const got = await searchOfNode(node, league)
    if (got && canon(got.query) === want) return node.id
  }
  return null
}

export async function openInTrading({ query, name, league, store, go, wait = () => new Promise(r => setTimeout(r, 100)), tries = 100 }) {
  go()
  for (let i = 0; !store().loaded; i++) {
    if (i >= tries) return
    await wait()
  }
  const st = store()
  const id = await sameSearch(st.tree, query, league)
  if (id) { st.setActive(id); return }
  let folder = st.tree.find(n => n.kind === 'folder' && !n.sys && n.name === FROM_STRATS)?.id
  if (!folder) { folder = st.addFolder(null); st.rename(folder, FROM_STRATS) }
  st.ingest({ source: 'strat', q: JSON.stringify(query), name, targetId: folder })
}
