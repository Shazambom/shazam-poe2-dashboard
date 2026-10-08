import { flatten, pathOf } from './tree.js'
import { search } from './search.js'
import { DESTS } from './dests.js'

const screenLabel = (id) => DESTS.find(d => d.id === id)?.label ?? id
const tabAka = (t) => DESTS.find(d => d.section === t && !d.sub)?.aka

// The ⌘K palette's rows, pure so the order is testable. Opened empty, it starts with the current screen's
// actions (owner, 2026-10-05), then the tabs (⌘1–⌘5), sub-views, saved searches and board currencies. Typing
// also reaches every currency the app knows (`currencies`) and the app-wide commands (time window, themes).
// searches everything with the shared search — other screens' actions, the app-wide commands (themes) and leagues
// too — and this screen's matching actions still come first. Labels match, and so do the players' words (`aka`).
export function buildPaletteItems({ tabs = [], subDests = [], rows = [], currencies = [], leagues = [], commands = [], tree = [],
  screen = null, screenCommands = {}, q = '' }) {
  const cmd = (c, hint) => ({ kind: 'cmd', id: c.id, label: c.label, hint, aka: c.aka, run: c.run })
  const own = (screenCommands[screen] || []).map(c => cmd(c, c.keys || ''))
  const others = Object.entries(screenCommands).filter(([s]) => s !== screen)
    .flatMap(([s, cs]) => cs.map(c => cmd(c, [screenLabel(s), c.keys].filter(Boolean).join(' · '))))
  const app = commands.map(c => cmd(c, c.hint || ''))
  const views = tabs.map((t, i) => ({ kind: 'view', id: t, label: t, hint: `⌘${i + 1}`, aka: tabAka(t) }))
  const subs = subDests.map(d => ({ kind: 'sub', id: `${d.section}:${d.sub}`, section: d.section, sub: d.sub, label: d.label, aka: d.aka, hint: `${d.section} view` }))
  const searches = flatten(tree, x => x.kind === 'search').map(n => {
    const path = pathOf(tree, n.id) || []
    return { kind: 'ws', id: n.id, label: `Open search: ${n.name}`, hint: path.length ? path.join(' / ') : 'Workspace' }
  })
  // The board's cards first (they open on the board), then every other currency the app knows (first-contact
  // audit, 2026-10-08: "exalt" found only the Perfect Exalted card); the same row never twice.
  const onBoard = new Set(rows.map(r => r.id))
  const curs = [...rows.map(r => ({ kind: 'cur', id: r.id, label: r.name || r.id, hint: 'Open on board', onBoard: true })),
    ...currencies.filter(c => !onBoard.has(c.id)).map(c => ({ kind: 'cur', id: c.id, label: c.name || c.id, hint: 'Open chart', onBoard: false }))]
  const lgs = leagues.map(l => ({ kind: 'league', id: l.id, label: l.text || l.id, hint: 'Switch league', aka: ['league'] }))
  if (!q.trim()) return [...own, ...views, ...subs, ...searches, ...curs]
  const fields = i => [[i.label], i.aka]
  return [...search(own, q, fields), ...search([...views, ...subs, ...others, ...app, ...searches, ...curs, ...lgs], q, fields)]
}
