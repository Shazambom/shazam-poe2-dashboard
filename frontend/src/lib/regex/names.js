// Every name an item can print, expanded from the harvested vocabulary in
// frontend/src/data/regex/map-names.json: `patterns` are templates over `vocab` word lists
// ("{waystone_first} {waystone_second}"), each expanded to its full cross product. A token may
// match none of these lines.
export function namePool({ vocab, patterns }) {
  const expand = (pattern) => {
    let out = ['']
    for (const part of pattern.split(/(\{[a-z_]+\})/)) {
      if (!part) continue
      const words = part.startsWith('{') ? vocab[part.slice(1, -1)] : [part]
      if (!words) throw new Error(`map-names.json: unknown list ${part}`)
      out = out.flatMap(prefix => words.map(w => prefix + w))
    }
    return out
  }
  return patterns.flatMap(expand)
}
