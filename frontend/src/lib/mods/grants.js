const AFFIX = { prefix: 'Prefix', suffix: 'Suffix', implicit: 'Implicit' }

// Essence rows: one per class row (an essence may force one mod per affix).
export const essenceRows = (essences) => essences.flatMap(e => e.rows.map((r, i) => ({ key: `${e.name}:${i}`, name: e.name, badge: AFFIX[r.affix] || r.affix, lines: [{ text: r.text }], level: r.level })))

// Socketable rows: the effect, then the bonded effect.
export const augmentRows = (augments) => augments.map(a => ({ key: a.id, name: a.name, badge: a.type, level: a.level, lines: [...a.text.map(text => ({ text })), ...a.bonded.map(text => ({ text, cls: 'mods-bonded' }))] }))
