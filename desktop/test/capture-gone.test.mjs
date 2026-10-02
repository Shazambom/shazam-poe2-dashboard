// The trade window's search is read from its own address (frontend TradeBuilder.jsx + session.searchOfLink),
// through the existing trade:webview-nav event: no request interception in main (simplify 2026-10-01).
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

test('no request capture: no searchcapture/webrequest modules, no capture IPC', () => {
  assert.ok(!existsSync(new URL('../src/trade/searchcapture.js', import.meta.url)))
  assert.ok(!existsSync(new URL('../src/webrequest.js', import.meta.url)))
  const idx = readFileSync(new URL('../src/trade/index.js', import.meta.url), 'utf8')
  const pre = readFileSync(new URL('../src/preload.js', import.meta.url), 'utf8')
  assert.ok(!/capture-(start|take|stop)/.test(idx + pre))
})
