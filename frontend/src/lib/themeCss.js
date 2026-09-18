// Reads the theme presets out of styles.css text: the bare `:root` block (Vault) and every
// `:root[data-theme="x"]` block. Same block grammar as scripts/lint-style.mjs. Pure (no DOM,
// no imports) so the builder, the exporter and the node tests share ONE reading of the CSS.

// Tokens a preset never touches (mirror of NEVER_THEMED in scripts/lint-style.mjs).
export const NEVER_THEMED = new Set([
  '--afk', '--offline',
  '--rarity-normal', '--rarity-magic', '--rarity-rare', '--rarity-unique', '--rarity-gem', '--rarity-currency',
  '--radius', '--radius-lg', '--shadow-1', '--shadow-2', '--ease', '--font', '--card-gradient', '--glow-gold',
])

// { root: Map(token → value), presets: { id: Map(token → value) } } in source order.
export function parseThemeBlocks(cssText) {
  const lines = cssText.split('\n')
  const out = { root: null, presets: {} }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*:root(\[data-theme="([a-z0-9-]+)"\])?\s*\{/)
    if (!m) continue
    const end = lines.findIndex((l, j) => j > i && l.includes('}'))
    if (end === -1) break
    const tokens = new Map()
    for (let j = i + 1; j < end; j++) {
      for (const t of lines[j].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) tokens.set(t[1], t[2].trim())
    }
    if (m[2]) out.presets[m[2]] = tokens; else out.root = tokens
  }
  return out
}

// The colour table of every preset (Vault included) as { id: { '--bg': '#0f1116', … } } — only the
// themed keys, in :root order, so an export writes the same key set the linter demands.
export function presetTables(cssText) {
  const { root, presets } = parseThemeBlocks(cssText)
  const keys = [...root.keys()].filter(k => !NEVER_THEMED.has(k))
  const pick = (map) => Object.fromEntries(keys.map(k => [k, (map.get(k) ?? root.get(k)).replace(/\s+/g, '')]))
  const tables = { vault: pick(root) }
  for (const [id, map] of Object.entries(presets)) tables[id] = pick(map)
  return { keys, tables }
}
