// Pins desktop/src/updater-channel.js — pointing electron-updater at the beta or stable feed never
// allows a downgrade. electron-updater's `channel` setter sets `allowDowngrade = true`
// (node_modules/electron-updater/out/AppUpdater.js), and on the beta channel the GitHub provider
// picks the first semver tag in the feed, which right after a stable ship is the previous beta:
// a stable 0.3.6 user who ticked "Beta updates" was offered 0.3.6-beta.12 (audit 2026-09-29, D1).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const { applyChannel } = await import('../src/updater-channel.js')

// Mirrors the real updater: setting `channel` switches downgrades on.
function fakeUpdater() {
  return { allowPrerelease: false, allowDowngrade: false, _channel: null,
    set channel(v) { this._channel = v; this.allowDowngrade = true }, get channel() { return this._channel } }
}

test('beta: prerelease feed, never a downgrade', () => {
  const au = fakeUpdater()
  assert.equal(applyChannel(au, true), true)
  assert.deepEqual([au.channel, au.allowPrerelease, au.allowDowngrade], ['beta', true, false])
})

test('stable: latest feed, never a downgrade', () => {
  const au = fakeUpdater()
  assert.equal(applyChannel(au, false), false)
  assert.deepEqual([au.channel, au.allowPrerelease, au.allowDowngrade], ['latest', false, false])
})

test('the real channel setter still turns downgrades on (the reason this module exists)', () => {
  const src = readFileSync(new URL('../node_modules/electron-updater/out/AppUpdater.js', import.meta.url), 'utf8')
  assert.match(src, /set channel\(value\)[\s\S]{0,600}this\.allowDowngrade = true/)
})

test('main.js sets the channel only through applyChannel', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  assert.ok(!/\.channel\s*=/.test(main), 'main.js assigns a channel directly')
  assert.ok(main.includes("require('./updater-channel.js')"))
})
