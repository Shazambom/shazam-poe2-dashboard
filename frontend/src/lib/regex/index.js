// The Regex tab's one entry point: a kind, its settings, its table → the string, or the trade
// query. Pure; no I/O, no React, no network (frontend/test/regex-bundle.test.mjs holds it to that).
import { waystoneRegex } from './waystone.js'
import { tabletRegex } from './tablet.js'
import { waystoneQuery, tabletQuery } from './trade.js'
export { defaults, defaultOptions, merge, overLimit, LIMIT, KINDS } from './defaults.js'

const BY_KIND = { waystone: [waystoneRegex, waystoneQuery], tablet: [tabletRegex, tabletQuery] }

export const generate = (kind, settings, table) => BY_KIND[kind] ? BY_KIND[kind][0](settings, table) : ''
export const query = (kind, settings, table) => BY_KIND[kind] ? BY_KIND[kind][1](settings, table) : null
