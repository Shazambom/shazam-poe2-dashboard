import { flatten, pathOf } from './tree.js'

// The ⌘K palette's rows, pure so the list is testable: views, sub-views, board currencies,
// leagues, workspace commands, and one "Open search: <name>" per saved search (hint = its
// folder path). `q` filters by label, case-insensitively.
export function buildPaletteItems({ tabs = [], subDests = [], rows = [], leagues = [], commands = [], tree = [], q = '' }) {
  const list = []
  for (const c of commands) list.push({ kind: 'cmd', id: c.id, label: c.label, hint: c.hint || 'Workspace', run: c.run })
  for (const t of tabs) list.push({ kind: 'view', id: t, label: t, hint: 'Go to view' })
  for (const d of subDests) list.push({ kind: 'sub', id: `${d.section}:${d.sub}`, section: d.section, sub: d.sub, label: d.label, hint: `${d.section} view` })
  for (const n of flatten(tree, x => x.kind === 'search')) {
    const path = pathOf(tree, n.id) || []
    list.push({ kind: 'ws', id: n.id, label: `Open search: ${n.name}`, hint: path.length ? path.join(' / ') : 'Workspace' })
  }
  for (const r of rows) list.push({ kind: 'cur', id: r.id, label: r.name || r.id, hint: 'Open on board' })
  for (const l of leagues) list.push({ kind: 'league', id: l.id, label: l.text || l.id, hint: 'Switch league' })
  const term = q.trim().toLowerCase()
  return term ? list.filter(i => i.label.toLowerCase().includes(term)) : list
}
