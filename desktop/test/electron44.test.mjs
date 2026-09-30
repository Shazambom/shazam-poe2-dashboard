// Pins the Electron 44 upgrade (from 33): the APIs whose shape changed are used in their new form
// (electron/docs/breaking-changes.md 34–44), and the toolchain meets Electron 44's Node floor.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const ci = readFileSync(new URL('../../.github/workflows/release-desktop-win.yml', import.meta.url), 'utf8')

test('electron 44 and a builder that packages it', () => {
  assert.match(pkg.devDependencies.electron, /^\^44\./)
  assert.match(pkg.devDependencies['electron-builder'], /^\^26\./)
})

test('console-message uses the event-object form (35.0: positional args deprecated)', () => {
  assert.ok(!/on\('console-message', \(_?e\w*, level, message/.test(main), 'old positional signature')
  assert.match(main, /on\('console-message', \(\{ level, message \}\) =>/)
})

test('CI builds with a Node that Electron 44 accepts (>= 22.12)', () => {
  assert.match(ci, /node-version: '22'/)
  assert.equal(pkg.engines?.node, '>=22.12.0')
})

test('the Mac app is ad-hoc signed, so macOS shows its notifications (42.0: UNNotification needs a signed app)', () => {
  // Unsigned (identity: null), notifications failed with UNErrorDomain error 1 on Electron 44; an ad-hoc
  // signature over the whole bundle (no Apple certificate) shows them. Verified on the packaged app.
  assert.equal(pkg.build.mac.identity, '-')
  // Keep the hardened runtime. For identity "-" electron-builder signs with its built-in ad-hoc
  // entitlements (allow-jit + disable-library-validation: Electron's prebuilt frameworks carry
  // another Team ID), relaxing only library validation (electron.build code-signing-mac).
  assert.notEqual(pkg.build.mac.hardenedRuntime, false, 'do not switch the hardened runtime off')
  assert.equal(pkg.build.mac.entitlements, undefined, "a custom entitlements file must add disable-library-validation itself")
})
