// Knobs are for tweakers (owner, 2026-10-08): the numeric arbitrage controls and the Settings plumbing show on beta and
// dev clients only; stable shows presets. The desktop answers with the one gate it already has for diagnostics
// (`tweaks: diagTelemetryOn()`), so the renderer never recomposes "beta or dev"; the web test env (no bridge) is the
// staging surface and shows them. The Beta toggle refreshes the answer at once (code review: it used to wait for a restart).
import test from 'node:test'
import assert from 'node:assert/strict'
import { tweaksOn, refreshTweaks, currentTweaks } from '../src/lib/tweaks.js'

test('a stable packaged desktop client hides the knobs; beta and dev show them', () => {
  assert.equal(tweaksOn({ desktop: true, channel: { tweaks: false } }), false)
  assert.equal(tweaksOn({ desktop: true, channel: { tweaks: true } }), true)
})

test('the web test env shows them; an unanswered desktop channel hides them', () => {
  assert.equal(tweaksOn({ desktop: false, channel: null }), true)
  assert.equal(tweaksOn({ desktop: true, channel: null }), false)
})

test('the Beta toggle\'s answer replaces the cached one', () => {
  refreshTweaks({ beta: true, locked: false, tweaks: true })
  assert.equal(currentTweaks(), true)
  refreshTweaks({ beta: false, locked: false, tweaks: false })
  assert.equal(currentTweaks(), false)
})
