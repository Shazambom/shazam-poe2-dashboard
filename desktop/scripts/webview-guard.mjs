// The drive helper's guard (scripts/webview.mjs): nav/click/type/key can make the trade site run a search, and the
// Workspace saves every search into the ACTIVE row — the owner's, on a dev or packaged launch (they share the owner's
// data dir). Such commands must name the row they work in (--row <id>) and run only when it is the active one, or when
// nothing is selected. Returns null when allowed, else the reason.
export const CHANGES_PAGE = new Set(['nav', 'click', 'type', 'key'])

export function guard({ cmd, row, activeId }) {
  if (!CHANGES_PAGE.has(cmd) || activeId == null) return null
  if (!row) return `${cmd} needs --row <your throwaway row's data-id>: the active row (${activeId}) would save this search`
  if (row !== activeId) return `the active row is ${activeId}, not ${row}: select your own row first`
  return null
}
