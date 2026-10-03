// Bug XWZGZ0 (0.3.9, win32): Trading → Sales — scrolling down, "What you hold" is cut off and its last
// currencies never show, even fullscreen. The holdings column is `position: sticky; top: 0` with no height
// bound: once the card is taller than the viewport, sticky pins its top and its bottom rows stay below the
// fold while the ledger scrolls. A sticky column must fit the viewport and scroll its own overflow.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const ROOT = new URL('../', import.meta.url).pathname
const css = readFileSync(`${ROOT}src/styles.css`, 'utf8')

test('the sticky Sales holdings column fits the viewport and scrolls its own overflow', () => {
  const m = css.match(/\.sales-capital\s*\{([^}]*)\}/)
  assert.ok(m, '.sales-capital rule present')
  const body = m[1]
  if (!/position:\s*sticky/.test(body)) return   // not sticky: the card scrolls with the page, nothing to bound
  assert.match(body, /max-height:\s*[^;]*(vh|dvh|svh|100%)/, 'sticky .sales-capital has a viewport max-height')
  assert.match(body, /overflow(-y)?:\s*(auto|scroll)/, 'sticky .sales-capital scrolls its overflow')
})
