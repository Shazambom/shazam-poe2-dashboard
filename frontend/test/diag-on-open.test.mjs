// Opening Settings no longer runs the diagnostics probe (table counts + outbound connectivity checks);
// it runs the first time the Diagnostics section is opened (audit 2026-09-29, U3).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/components/SettingsView.jsx', import.meta.url), 'utf8')
const panel = src.slice(src.indexOf('function DiagPanel('))

test('DiagPanel never probes on mount', () => {
  assert.ok(!/useEffect\(\(\) => \{ run\(\) \}, \[\]\)/.test(panel), 'unconditional probe on mount')
})

test('it probes once the Diagnostics section is opened', () => {
  assert.match(panel, /function DiagPanel\(\{ open \}\)/)
  assert.match(panel, /if \(open && !d\) run\(\)/)
  assert.match(src, /<details className="adv" onToggle=\{e => setDiagOpen\(e\.currentTarget\.open\)\}>\s*<summary>Diagnostics<\/summary>/)
  assert.match(src, /<DiagPanel open=\{diagOpen\} \/>/)
})
