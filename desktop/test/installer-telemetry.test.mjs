// The Windows installer sends no telemetry. Its customInit posted OS version, username and process paths
// on every install, stable included, outside the one diagnostics gate (`diagTelemetryOn()`, which an
// installer cannot reach). It was a temporary diagnostic for the Windows update self-heal; removed
// (audit 2026-09-29, D4; owner: "just remove dead code").
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const nsh = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8')

test('the installer posts nowhere', () => {
  assert.ok(!/installlog|Invoke-RestMethod|Invoke-WebRequest|192\.168\./.test(nsh))
  assert.ok(!nsh.includes('!macro customInit'), 'no reporting hook left behind')
})

test('the self-heal (preInit) is kept', () => {
  assert.ok(nsh.includes('!macro preInit'))
  assert.ok(nsh.includes('taskkill /F /T /IM "poe2arb-backend.exe"'))
})
