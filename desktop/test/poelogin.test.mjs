// Connect is confirmed by the trade site showing a signed-in page, never by a cookie existing
// (the site gives anonymous visitors a POESESSID too; owner 2026-10-07: "I shouldn't be connected
// until I am confirmed logged in").
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const { loginConfirmedAt } = createRequire(import.meta.url)('../src/poelogin.js')

test('the login form, its variants and the Steam hop are not a confirmed login', () => {
  for (const u of [
    'https://www.pathofexile.com/login',
    'https://www.pathofexile.com/login?return=%2Fmy-account',
    'https://www.pathofexile.com/login/steam',
    'https://www.pathofexile.com/LOGIN',
    'https://www.pathofexile.com/logout',
    'https://steamcommunity.com/openid/login?openid.mode=checkid_setup',
    'http://www.pathofexile.com/my-account',
    'https://evil.example/my-account',
    'about:blank', '', undefined,
  ]) assert.equal(loginConfirmedAt(u), false, u)
})

test('any other pathofexile.com page is where the site lands a signed-in user', () => {
  for (const u of [
    'https://www.pathofexile.com/my-account',
    'https://www.pathofexile.com/',
    'https://www.pathofexile.com/trade2/search/poe2/Standard',
    'https://pathofexile.com/account/view-profile/x',
  ]) assert.equal(loginConfirmedAt(u), true, u)
})

test('connect never short-circuits on an existing cookie; it confirms from a signed-in page, positively', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  const flow = main.slice(main.indexOf('function connectPoeFlow'), main.indexOf('async function connectPoeSession'))
  assert.ok(!/const existing = await getPoeCookie\(\)/.test(flow), 'the "existing cookie" shortcut is gone')
  assert.ok(/loginConfirmedAt\(/.test(flow), 'only pages worth probing are probed')
  // code review 2026-10-08: "not /login" is not proof (Forgot password, Register, the logo all leave /login); the
  // page itself says whether it is signed in (its log-out link), and the window is always showable so it can be closed
  assert.ok(/executeJavaScript\(SIGNED_IN_PROBE/.test(flow), 'a positive signal from the page')
  // owner 2026-10-08, "I'm auto logged in but the cookie isn't captured": one probe on did-navigate ran before the
  // page had a DOM. The page is probed when its DOM is ready and then every LOGIN_POLL_MS until it is signed in.
  assert.ok(/wc\.on\('dom-ready'/.test(flow), 'probed when the DOM is ready')
  assert.ok(/setInterval\([\s\S]{0,80}LOGIN_POLL_MS\)/.test(flow), 'and polled until signed in')
  assert.ok(/clearInterval\(/.test(flow), 'the poll stops with the window')
  assert.ok(/const show = \(\) => \{ if \(!login\.isDestroyed\(\) && !login\.isVisible\(\)\) login\.show\(\) \}/.test(flow), 'one way to show the window')
  assert.ok(/not signed in[^\n]*show\(\); return/.test(flow), 'a page that is not signed in shows the window, so it can always be closed')
  assert.ok(/if \(confirmed \|\| probing \|\| login\.isDestroyed\(\)\) return/.test(flow), 'one probe at a time; none after confirmation')
  assert.ok(/confirmed = true\n[\s\S]{0,120}clearInterval\(poll\)/.test(flow), 'confirmed stops the poll before posting')
})

test('the signed-in probe reads the page\'s own signed-in signals, never a cookie', () => {
  const { SIGNED_IN_PROBE, LOGIN_POLL_MS } = createRequire(import.meta.url)('../src/poelogin.js')
  assert.match(SIGNED_IN_PROBE, /logout/)
  assert.match(SIGNED_IN_PROBE, /Logged in as/)
  assert.doesNotMatch(SIGNED_IN_PROBE, /cookie/i)
  assert.ok(LOGIN_POLL_MS >= 500 && LOGIN_POLL_MS <= 3000)
})

test('both channel answers carry the one beta-or-dev gate (knobs show on beta and dev only)', () => {
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  const get = main.slice(main.indexOf("ipcMain.handle('update:getChannel'"), main.indexOf("ipcMain.handle('update:setChannel'"))
  const set = main.slice(main.indexOf("ipcMain.handle('update:setChannel'"), main.indexOf("ipcMain.handle('update:setChannel'") + 500)
  assert.match(get, /tweaks: diagTelemetryOn\(\)/)
  assert.match(set, /tweaks: diagTelemetryOn\(\)/)
  assert.doesNotMatch(get, /dev: !app\.isPackaged/, 'the renderer reads the gate, never its parts')
})
