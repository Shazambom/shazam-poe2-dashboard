// RuleTester cases for the in-repo `arbiter` ESLint plugin. Run: node --test ops/lint/arbiter-plugin.test.mjs
// Each rule gets valid and invalid cases; options mirror how eslint.config.mjs sets them per path.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import path from 'node:path'
import { RuleTester } from 'eslint'
import plugin from './arbiter-plugin.mjs'

RuleTester.describe = describe
RuleTester.it = it

const at = (rel) => path.join(process.cwd(), rel)
const cjs = new RuleTester({ languageOptions: { ecmaVersion: 2025, sourceType: 'commonjs' } })
const esm = new RuleTester({ languageOptions: { ecmaVersion: 2025, sourceType: 'module' } })
const rule = (name) => plugin.rules[name]

describe('plugin shape', () => {
  it('exports exactly the in-scope rules', () => {
    assert.deepEqual(Object.keys(plugin.rules).sort(), [
      'catch-must-handle',
      'network-primitives-allowlist',
      'no-env-config',
      'no-raw-ipcrenderer-expose',
      'preload-require-electron-only',
      'rate-limit-headers-backend-only',
      'secure-web-preferences',
      'telemetry-single-sender',
    ])
  })
  it('every message tells the reader to ask the owner when the rule is wrong', () => {
    for (const [name, r] of Object.entries(plugin.rules)) {
      assert.ok(Object.keys(r.meta.messages).length > 0, name)
      for (const text of Object.values(r.meta.messages)) {
        assert.match(text, /If the rule is wrong for this code, stop and ask the owner\.$/, `${name}: ${text}`)
      }
    }
  })
})

esm.run('catch-must-handle', rule('catch-must-handle'), {
  valid: [
    'try { f() } catch (e) { log(e) }',
    'function g() { try { f() } catch { return null } }',
    'try { f() } finally { g() }',
    'p.catch((e) => log(e))',
    'p.catch((e) => { log(e) })',
    'p.catch(handle)',
    'p.then(ok, (e) => { log(e) })',
    'x.catch()',
  ],
  invalid: [
    { code: 'try { f() } catch {}', errors: [{ messageId: 'emptyCatch' }] },
    { code: 'try { f() } catch (e) {}', errors: [{ messageId: 'emptyCatch' }] },
    { code: 'try { f() } catch { /* ignore: best effort */ }', errors: [{ messageId: 'emptyCatch' }] },
    { code: 'try { f() } catch {\n  // the comment is not handling\n}', errors: [{ messageId: 'emptyCatch' }] },
    { code: 'p.catch(() => {})', errors: [{ messageId: 'emptyPromiseCatch' }] },
    { code: 'p.catch(function () { /* nothing */ })', errors: [{ messageId: 'emptyPromiseCatch' }] },
    { code: 'p.then(ok).catch((_e) => {\n  // swallowed\n})', errors: [{ messageId: 'emptyPromiseCatch' }] },
    { code: 'p.then(ok, () => {})', errors: [{ messageId: 'emptyPromiseCatch' }] },
  ],
})

const OWNERS = {
  owners: {
    fetch: ['desktop/src/telemetry.js', 'desktop/src/local-backend.js'],
    net: ['desktop/src/trade/proxy.js'],
    ws: ['desktop/src/trade/engine.js'],
    http: ['desktop/src/main.js'],
  },
}
const net = (code, file) => ({ code, filename: at(file), options: [OWNERS] })
cjs.run('network-primitives-allowlist', rule('network-primitives-allowlist'), {
  valid: [
    net('fetch(url)', 'desktop/src/telemetry.js'),
    net('globalThis.fetch(url)', 'desktop/src/local-backend.js'),
    net("const { net } = require('electron'); net.request(o)", 'desktop/src/trade/proxy.js'),
    net("const WebSocket = require('ws'); new WebSocket(u)", 'desktop/src/trade/engine.js'),
    net("const http = require('node:http')", 'desktop/src/main.js'),
    // A local binding called fetch is not the network primitive.
    net('function go(fetch) { return fetch(1) }', 'desktop/src/trade/sales.js'),
    net('const fetch = (x) => x; fetch(1)', 'desktop/src/trade/sales.js'),
    net('merchant.fetch(p); sales.fetch(p)', 'desktop/src/trade/index.js'),
    // Replacing the global with a refusing shim is not a network call.
    net('globalThis.fetch = makeFetch(dir)', 'desktop/src/vendor/ee2-query/index.js'),
    net("const { app } = require('electron')", 'desktop/src/menu.js'),
  ],
  invalid: [
    { ...net('fetch(url)', 'desktop/src/main.js'), errors: [{ messageId: 'primitive', data: { what: 'fetch', owners: 'desktop/src/telemetry.js, desktop/src/local-backend.js' } }] },
    { ...net('async function f() { await fetch(u) }', 'desktop/src/trade/budget.js'), errors: [{ messageId: 'primitive' }] },
    { ...net('globalThis.fetch(u)', 'desktop/src/modsdiag.js'), errors: [{ messageId: 'primitive' }] },
    { ...net('const deps = { fetch }', 'desktop/src/trade/sales.js'), errors: [{ messageId: 'primitive' }] },
    { ...net("const { net } = require('electron')", 'desktop/src/main.js'), errors: [{ messageId: 'primitive', data: { what: 'electron net', owners: 'desktop/src/trade/proxy.js' } }] },
    { ...net("require('electron').net.request(o)", 'desktop/src/main.js'), errors: [{ messageId: 'primitive' }] },
    { ...net("const electron = require('electron'); electron.net.fetch(u)", 'desktop/src/main.js'), errors: [{ messageId: 'primitive' }] },
    { ...net('session.defaultSession.fetch(u)', 'desktop/src/main.js'), errors: [{ messageId: 'primitive' }] },
    { ...net("const WebSocket = require('ws')", 'desktop/src/trade/index.js'), errors: [{ messageId: 'primitive', data: { what: 'ws', owners: 'desktop/src/trade/engine.js' } }] },
    { ...net('new WebSocket(u)', 'desktop/src/trade/index.js'), errors: [{ messageId: 'primitive' }] },
    { ...net("require('http')", 'desktop/src/feedback/index.js'), errors: [{ messageId: 'primitive' }] },
    { ...net("require('node:https')", 'desktop/src/main.js'), errors: [{ messageId: 'primitive', data: { what: 'https', owners: 'no module' } }] },
    { ...net("require('net'); require('tls'); require('dgram'); require('undici'); require('http2')", 'desktop/src/main.js'), errors: 5 },
    { ...net("import('node:http')", 'desktop/src/menu.js'), errors: [{ messageId: 'primitive' }] },
    { ...net('new XMLHttpRequest(); new EventSource(u)', 'desktop/src/main.js'), errors: 2 },
  ],
})

const TEL = { owner: 'desktop/src/telemetry.js' }
cjs.run('telemetry-single-sender', rule('telemetry-single-sender'), {
  valid: [
    { code: "const SHAZAM = 'http://192.168.1.250:8080'; function installLog() {}", filename: at('desktop/src/telemetry.js'), options: [TEL] },
    { code: "const { installLog } = require('./telemetry.js'); installLog('x', 'y')", filename: at('desktop/src/dev-ee2-telemetry.js'), options: [TEL] },
    { code: 'function make({ installLog }) { return installLog }', filename: at('desktop/src/diag-bridge.js'), options: [TEL] },
    { code: 'const u = telemetry.SHAZAM', filename: at('desktop/src/main.js'), options: [{ ...TEL, allowRead: ['SHAZAM'] }] },
    { code: "const u = 'http://127.0.0.1:8000/api/diag'", filename: at('desktop/src/main.js'), options: [TEL] },
  ],
  invalid: [
    { code: 'const u = telemetry.SHAZAM', filename: at('desktop/src/main.js'), options: [TEL], errors: [{ messageId: 'read' }] },
    { code: "const u = require('./telemetry.js').SHAZAM", filename: at('desktop/src/main.js'), options: [TEL], errors: [{ messageId: 'read' }] },
    { code: "const { SHAZAM } = require('./telemetry.js')", filename: at('desktop/src/main.js'), options: [TEL], errors: [{ messageId: 'read' }] },
    { code: "post('http://192.168.1.250:8080/api/installlog?p=x')", filename: at('desktop/src/updater-channel.js'), options: [TEL], errors: [{ messageId: 'url' }] },
    { code: 'post(`http://shazam/${p}`)', filename: at('desktop/src/main.js'), options: [TEL], errors: [{ messageId: 'url' }] },
    { code: "const u = 'http://10.0.0.5/x'", filename: at('desktop/src/main.js'), options: [TEL], errors: [{ messageId: 'url' }] },
    { code: 'function installLog(m) { return m }', filename: at('desktop/src/main.js'), options: [TEL], errors: [{ messageId: 'sender' }] },
    { code: 'const installLog = (m) => m', filename: at('desktop/src/main.js'), options: [TEL], errors: [{ messageId: 'sender' }] },
  ],
})

const OS = ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'HOME', 'USERPROFILE']
cjs.run('no-env-config', rule('no-env-config'), {
  valid: [
    { code: 'const h = process.env.HOME', options: [{ allow: OS }] },
    { code: "const h = process.env['APPDATA']", options: [{ allow: OS }] },
    { code: 'const { HOME, USERPROFILE } = process.env', options: [{ allow: OS }] },
    { code: 'spawn(bin, [], { env: { ...process.env, PORT: "1" } })', options: [{ allow: OS }] },
    { code: 'cp.fork(m, [], { env: process.env })', options: [{ allow: OS }] },
    { code: 'utilityProcess.fork(m, [], { env: { ...process.env } })', options: [{ allow: OS }] },
    { code: 'const u = process.env.ARBITER_DEV_BACKEND_URL || x', options: [{ allow: [...OS, 'ARBITER_DEV_BACKEND_URL'] }] },
    { code: 'const env = 1; env.TRADE_DEBUG', options: [{ allow: OS }] },
  ],
  invalid: [
    { code: 'const DBG = !!process.env.TRADE_DEBUG', options: [{ allow: OS }], errors: [{ messageId: 'read', data: { name: 'TRADE_DEBUG' } }] },
    { code: "const v = process.env['FEATURE_X']", options: [{ allow: OS }], errors: [{ messageId: 'read' }] },
    { code: 'const { FEATURE_X } = process.env', options: [{ allow: OS }], errors: [{ messageId: 'read' }] },
    { code: 'const k = process.env[name]', options: [{ allow: OS }], errors: [{ messageId: 'dynamic' }] },
    { code: 'const all = process.env', options: [{ allow: OS }], errors: [{ messageId: 'dynamic' }] },
    { code: 'const copy = { ...process.env }', options: [{ allow: OS }], errors: [{ messageId: 'dynamic' }] },
    { code: 'process.env.ARBITER_DEV_BACKEND_URL', options: [{ allow: OS }], errors: [{ messageId: 'read' }] },
    { code: 'process.env.FLAG = "1"', options: [{ allow: OS }], errors: [{ messageId: 'read' }] },
  ],
})

cjs.run('preload-require-electron-only', rule('preload-require-electron-only'), {
  valid: [
    "const { contextBridge, ipcRenderer } = require('electron')",
    "const electron = require('electron')",
  ],
  invalid: [
    { code: "const fs = require('fs')", errors: [{ messageId: 'require', data: { name: 'fs' } }] },
    { code: "require('./helper.js')", errors: [{ messageId: 'require' }] },
    { code: 'require(name)', errors: [{ messageId: 'require', data: { name: '(computed)' } }] },
    { code: "import('electron')", errors: [{ messageId: 'require' }] },
  ],
})

const PRELOAD_HEAD = "const { contextBridge, ipcRenderer } = require('electron')\n"
cjs.run('no-raw-ipcrenderer-expose', rule('no-raw-ipcrenderer-expose'), {
  valid: [
    PRELOAD_HEAD + "contextBridge.exposeInMainWorld('x', { v: () => ipcRenderer.invoke('app-version') })",
    PRELOAD_HEAD + 'contextBridge.exposeInMainWorld("x", { s: (p) => ipcRenderer.send(`a:b`, p) })',
    // A helper whose every call site in the file passes a literal channel.
    PRELOAD_HEAD + "const sub = (ch) => (cb) => { const h = (_e, p) => cb(p); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h) }\n"
      + "contextBridge.exposeInMainWorld('x', { onA: sub('a'), onB: sub('b') })",
    PRELOAD_HEAD + "function call(ch, p) { return ipcRenderer.invoke(ch, p) }\ncontextBridge.exposeInMainWorld('x', { a: (p) => call('a', p) })",
  ],
  invalid: [
    { code: PRELOAD_HEAD + "contextBridge.exposeInMainWorld('x', { ipc: ipcRenderer })", errors: [{ messageId: 'expose' }] },
    { code: PRELOAD_HEAD + "contextBridge.exposeInMainWorld('x', ipcRenderer)", errors: [{ messageId: 'expose' }] },
    { code: PRELOAD_HEAD + "contextBridge.exposeInMainWorld('x', { invoke: ipcRenderer.invoke.bind(ipcRenderer) })", errors: [{ messageId: 'expose' }] },
    { code: PRELOAD_HEAD + 'const get = () => ipcRenderer', errors: [{ messageId: 'expose' }] },
    { code: PRELOAD_HEAD + "contextBridge.exposeInMainWorld('x', { invoke: ipcRenderer.invoke })", errors: [{ messageId: 'expose' }] },
    { code: PRELOAD_HEAD + "contextBridge.exposeInMainWorld('x', { invoke: (ch, p) => ipcRenderer.invoke(ch, p) })", errors: [{ messageId: 'channel' }] },
    { code: PRELOAD_HEAD + "contextBridge.exposeInMainWorld('x', { any: (...a) => ipcRenderer.invoke(...a) })", errors: [{ messageId: 'channel' }] },
    { code: PRELOAD_HEAD + 'contextBridge.exposeInMainWorld("x", { s: (n, p) => ipcRenderer.send(`a:${n}`, p) })', errors: [{ messageId: 'channel' }] },
    {
      code: PRELOAD_HEAD + "const sub = (ch) => (cb) => ipcRenderer.on(ch, cb)\ncontextBridge.exposeInMainWorld('x', { onA: sub('a'), on: (c) => sub(c) })",
      errors: [{ messageId: 'channel' }],
    },
    {
      code: PRELOAD_HEAD + "const sub = (ch) => (cb) => ipcRenderer.on(ch, cb)\ncontextBridge.exposeInMainWorld('x', { sub })",
      errors: [{ messageId: 'channel' }],
    },
  ],
})

const RL = { owners: ['desktop/src/trade/tap.js', 'desktop/src/trade/budget.js'] }
cjs.run('rate-limit-headers-backend-only', rule('rate-limit-headers-backend-only'), {
  valid: [
    { code: "if (key.startsWith('x-rate-limit')) h[key] = v", filename: at('desktop/src/trade/budget.js'), options: [RL] },
    { code: "const r = headers['X-Rate-Limit-Ip']", filename: at('desktop/src/trade/tap.js'), options: [RL] },
    { code: "const s = 'rate-limited, retry later'", filename: at('desktop/src/trade/engine.js'), options: [RL] },
  ],
  invalid: [
    { code: "const r = headers['x-rate-limit-ip-state']", filename: at('desktop/src/trade/engine.js'), options: [RL], errors: [{ messageId: 'parse' }] },
    { code: 'const re = /X-Rate-Limit-(\\w+)/', filename: at('desktop/src/trade/proxy.js'), options: [RL], errors: [{ messageId: 'parse' }] },
    { code: 'const k = `x-rate-limit-${kind}-state`', filename: at('desktop/src/main.js'), options: [RL], errors: [{ messageId: 'parse' }] },
  ],
})

esm.run('secure-web-preferences', rule('secure-web-preferences'), {
  valid: [
    'new BrowserWindow({ webPreferences: { sandbox: true, contextIsolation: true, preload: p } })',
    'new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } })',
    'new BrowserWindow({ width: 1, webPreferences: { sandbox: true, contextIsolation: true, webviewTag: true } })',
    'const o = { sandbox: false }',
  ],
  invalid: [
    { code: 'new BrowserWindow({ width: 1100, height: 800 })', errors: [{ messageId: 'mustState', data: { kind: 'BrowserWindow', missing: 'sandbox: true, contextIsolation: true' } }] },
    { code: 'new BrowserWindow({ webPreferences: { sandbox: true, zoomFactor: 1 } })', errors: [{ messageId: 'mustState', data: { kind: 'BrowserWindow', missing: 'contextIsolation: true' } }] },
    { code: 'new BrowserWindow(opts)', errors: [{ messageId: 'mustState' }] },
    { code: 'new BrowserWindow({ webPreferences: prefs })', errors: [{ messageId: 'mustState' }] },
    { code: 'new BrowserView({ webPreferences: { sandbox: false, contextIsolation: true } })', errors: [{ messageId: 'mustState' }, { messageId: 'insecure' }] },
    { code: 'new BrowserWindow({ webPreferences: { sandbox: true, contextIsolation: false } })', errors: [{ messageId: 'mustState' }, { messageId: 'insecure' }] },
    {
      code: 'new BrowserWindow({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: true, nodeIntegrationInWorker: true, nodeIntegrationInSubFrames: true } })',
      errors: 3,
    },
    {
      code: "new BrowserWindow({ webPreferences: { sandbox: true, contextIsolation: true, webSecurity: false, allowRunningInsecureContent: true, experimentalFeatures: true, enableBlinkFeatures: 'X' } })",
      errors: 4,
    },
    // Flags are checked wherever a webPreferences object is written, not only in constructors.
    { code: 'w.setWindowOpenHandler(() => ({ action: "allow", overrideBrowserWindowOptions: { webPreferences: { nodeIntegration: true } } }))', errors: [{ messageId: 'insecure' }] },
  ],
})
