import React from 'react'

// The Mods tab's two formatters, so a row and the total beneath it can never disagree.
// A share of nothing (null) and a share of zero both read as a dash.
export const pct = (x) => (x === null || x === undefined || x === 0 ? '–' : `${(x * 100).toFixed(1)}%`)

// Repeated stat lines can be identical. Count occurrences within each text so
// inserting or moving a different stat leaves its siblings' identities intact.
export function keyedLines(values, textOf) {
  const seen = new Map()
  return values.map(value => {
    const text = textOf(value)
    const occurrence = seen.get(text) || 0
    seen.set(text, occurrence + 1)
    return { value, key: JSON.stringify([text, occurrence]) }
  })
}

// A mod text as the game prints it: one line per stat.
export const lines = (text) => keyedLines(text.split('\n'), line => line).map(({ value, key }, i) => (
  <React.Fragment key={key}>{i > 0 && <br />}{value}</React.Fragment>
))
