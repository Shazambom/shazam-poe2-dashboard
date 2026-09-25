import React from 'react'

// The Mods tab's two formatters, so a row and the total beneath it can never disagree.
// A share of nothing (null) and a share of zero both read as a dash.
export const pct = (x) => (x === null || x === undefined || x === 0 ? '–' : `${(x * 100).toFixed(1)}%`)

// A mod text as the game prints it: one line per stat.
export const lines = (text) => text.split('\n').map((l, i) => <React.Fragment key={i}>{i > 0 && <br />}{l}</React.Fragment>)
