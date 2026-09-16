// One notification dispatcher, driven by settings.notifications (banner on, sound on, OS off).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

globalThis.window = undefined
globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
const N = await import('../src/lib/notifications.js')
const { useStatus } = await import('../src/lib/statusStore.js')
const { bus } = await import('../src/lib/api.js')

test('defaults: banner + sound on, OS off, for both families', () => {
  assert.deepEqual(N.notifyPrefs(), { volume: 0.5, live: { banner: true, sound: true, os: false }, signals: { banner: true, sound: true, os: false } })
  useStatus.setState({ settings: { notifications: { volume: 0.9, signals: { os: true } } } })
  const p = N.notifyPrefs()
  assert.equal(p.volume, 0.9); assert.equal(p.signals.os, true); assert.equal(p.signals.banner, true); assert.equal(p.live.os, false)
  useStatus.setState({ settings: null })
})

test('notify() dispatches only the channels the family has enabled', () => {
  const calls = []
  N.setChannels({ sound: (v) => calls.push(['sound', v]), os: (t, b, o) => calls.push(['os', t]) })
  const toasts = []; const off = bus.on(t => toasts.push(t))
  useStatus.setState({ settings: { notifications: { volume: 0.7, live: { os: true, sound: false }, signals: { banner: false } } } })
  N.notify('live', { title: 'Ping: X', body: 'b', node: 'NODE' })
  N.notify('signals', { title: '1 new market signal', body: 'Y', node: 'NODE2' })
  off()
  assert.deepEqual(calls, [['os', 'Ping: X'], ['sound', 0.7]])          // live: os+banner, no sound; signals: sound only
  assert.deepEqual(toasts.map(t => t.node), ['NODE'])
  useStatus.setState({ settings: null })
})

test('one home: notify.js is gone, liveWiring and App go through notify()', () => {
  assert.ok(!existsSync(new URL('../src/lib/notify.js', import.meta.url)))
  const lw = readFileSync(new URL('../src/lib/liveWiring.js', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
  for (const s of [lw, app]) { assert.ok(s.includes("notify('") || s.includes('notify("')); assert.ok(!s.includes('playPing(') && !s.includes('osNotify(')) }
  const sv = readFileSync(new URL('../src/components/SettingsView.jsx', import.meta.url), 'utf8')
  assert.ok(sv.includes('<NotificationsPanel'))
  const ts = readFileSync(new URL('../src/components/TradingSettings.jsx', import.meta.url), 'utf8')
  assert.ok(!ts.includes('ping_sound') && !ts.includes('Play a sound'))
})
