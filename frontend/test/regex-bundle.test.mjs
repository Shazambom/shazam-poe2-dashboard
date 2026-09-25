// The desktop contract, held on the Regex tab's sources: the generator library is pure (no network,
// no storage, no window), the mod tables are imported at build time, and the view reaches only
// the app's own modules. A packaged build must gain no outbound host from this feature.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')
const LIB = fs.readdirSync(path.join(SRC, 'lib', 'regex')).filter(f => f.endsWith('.js'))
const VIEWS = ['components/RegexView.jsx', 'components/RegexResult.jsx', 'components/ModPicker.jsx', 'components/Seg.jsx']
const BANNED = [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /localStorage/, /sessionStorage/, /window\.open\b/, /https?:\/\//, /nitropay/i, /buymeacoffee/i, /economy\.poe/i]

test('the generator library is pure: no network, no storage, no DOM, no imports outside itself', () => {
  assert.ok(LIB.length >= 8, LIB.join(','))
  for (const f of LIB) {
    const src = read(`lib/regex/${f}`)
    for (const re of BANNED) assert.equal(re.test(src), false, `${f} matches ${re}`)
    assert.equal(/\b(document|window|navigator)\b/.test(src), false, `${f} touches the DOM`)
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) assert.ok(m[1].startsWith('./'), `${f} imports ${m[1]}`)
  }
})

test('the view imports the tables as data and reaches only the app', () => {
  for (const v of VIEWS) {
    const src = read(v)
    for (const re of BANNED) assert.equal(re.test(src), false, `${v} matches ${re}`)
    assert.equal(/type\s*=\s*["']checkbox["']/.test(src), false, `${v} has a raw checkbox`)
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(src), false, `${v} has a raw colour`)
    for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
      const dep = m[1]
      assert.ok(dep === 'react' || dep.startsWith('./') || dep.startsWith('../lib/') || dep.startsWith('../data/regex/'), `${v} imports ${dep}`)
    }
  }
  const view = read('components/RegexView.jsx')
  assert.ok(/from '\.\.\/data\/regex\/waystone\.json'/.test(view) && /from '\.\.\/data\/regex\/tablet\.json'/.test(view), 'the tables ride in the bundle')
})

test('the tab is mounted under Trading, last, and only while selected', () => {
  const tv = read('components/TradingView.jsx')
  const subs = [...tv.matchAll(/id: '([a-z]+)', label:/g)].map(m => m[1])
  assert.equal(subs[subs.length - 1], 'regex', `sub-tabs: ${subs}`)
  assert.ok(/sub === 'regex'\s*&&\s*<RegexView/.test(tv), 'mounted on selection')
})

test('the shell does not know the feature exists', () => {
  const main = fs.readFileSync(path.join(HERE, '..', '..', 'desktop', 'src', 'main.js'), 'utf8')
  assert.equal(/regex_tools|RegexView|data\/regex/.test(main), false)
})
