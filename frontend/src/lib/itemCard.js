import React from 'react'
import { itemCardProps } from './sales.js'

// ItemCard: a trade item JSON rendered in Arbiter's style (double-line rarity header, property
// lines with augmented values, item level, requirements, mod groups, flags, the icon). Plain
// createElement (no JSX) so node tests can render it; components/ItemCard.jsx re-exports it.
// Reusable wherever the trade API's item shape shows up (Sales rows, live pings).
const h = React.createElement

export default function ItemCard({ item, compact = false }) {
  const p = itemCardProps(item)
  return h('div', { className: `item-card ${p.rarity}${compact ? ' compact' : ''}` },
    h('div', { className: 'ic-head' },
      p.icon ? h('img', { className: 'ic-icon', src: p.icon, alt: '', loading: 'lazy' }) : null,
      h('div', { className: 'ic-title' },
        p.name ? h('div', { className: 'ic-name' }, p.name) : null,
        h('div', { className: `ic-type ${p.name ? '' : 'ic-name'}` }, p.typeLine))),
    ...p.blocks.map((b, i) => h('div', { key: i, className: `ic-block ic-${b.kind}` },
      ...b.lines.map((l, j) => h('div', { key: j, className: `ic-line${l.augmented ? ' ic-augmented' : ''}` }, l.text)))))
}
