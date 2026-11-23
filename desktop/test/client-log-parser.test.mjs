// Client.txt parser, LogWatcher, and main/preload wiring tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseLine, toRendererEvent } = require('../src/integrations/exiled-exchange/client-log-parser.js')
const { LogWatcher, candidateLogPaths } = require('../src/integrations/exiled-exchange/log-watcher.js')

const P = '2026/09/16 21:03:11 123456789 1a2b3c4d [INFO Client 4321] '
const D = '2026/09/16 21:03:11 123456789 1a2b3c4d [DEBUG Client 4321] '

test('whispers, zone entry, area-gen, trade outcome, AFK', () => {
  const ts = new Date(2026, 8, 16, 21, 3, 11).getTime()   // Client.txt stamps local time
  assert.deepEqual(parseLine(P + '@From Trader_One: Hi, I would like to buy your Headhunter'), { type: 'whisper-in', name: 'Trader_One', text: 'Hi, I would like to buy your Headhunter', ts })
  assert.equal(parseLine(P + '@From <GUILD> Trader_One: hi').name, 'Trader_One', 'guild tag stripped')
  assert.equal(parseLine(P + '@To Buyer_Two: sure, one sec').type, 'whisper-out')
  assert.deepEqual(parseLine(P + ': You have entered The Ziggurat Refuge.'), { type: 'zone', zone: 'The Ziggurat Refuge', ts })
  assert.deepEqual(parseLine(P + 'Generating level 80 area "MapCrypt" with seed 123456789'), { type: 'area-gen', level: 80, areaId: 'MapCrypt', seed: '123456789', ts })
  assert.deepEqual(parseLine(D + 'Generating level 82 area "MapSavannah" with seed 9876543210'), { type: 'area-gen', level: 82, areaId: 'MapSavannah', seed: '9876543210', ts })
  assert.equal(parseLine(P + ': Trade accepted.').type, 'trade-accepted')
  assert.equal(parseLine(P + ': Trade cancelled.').type, 'trade-cancelled')
  assert.equal(parseLine(P + ': AFK mode is now ON. Autoreply "brb"').type, 'afk-on')
  assert.equal(parseLine(P + ': AFK mode is now OFF.').type, 'afk-off')
})

test('everything else is null; malformed input never throws', () => {
  assert.equal(parseLine(P + ': Random chat line'), null)
  assert.equal(parseLine(''), null)
  assert.equal(parseLine(null), null)
  assert.equal(parseLine('garbage'), null)
})

test('toRendererEvent forwards only area-gen, zone, afk-on, afk-off — never whisper text', () => {
  assert.equal(toRendererEvent(parseLine(P + 'Generating level 80 area "MapCrypt" with seed 123456789')).type, 'area-gen')
  assert.equal(toRendererEvent(parseLine(P + ': You have entered Crypt.')).type, 'zone')
  assert.equal(toRendererEvent(parseLine(P + ': AFK mode is now ON.')).type, 'afk-on')
  assert.equal(toRendererEvent(parseLine(P + ': AFK mode is now OFF.')).type, 'afk-off')
  assert.equal(toRendererEvent(parseLine(P + '@From Trader_One: secret whisper')), null)
  assert.equal(toRendererEvent(parseLine(P + '@To Buyer_Two: secret reply')), null)
  assert.equal(toRendererEvent(parseLine(P + ': Trade accepted.')), null)
  assert.equal(toRendererEvent(parseLine(P + ': Trade cancelled.')), null)
  assert.equal(toRendererEvent(null), null)
})

test('candidateLogPaths covers Windows standalone, Steam, SteamLibrary, macOS GGG + Steam, Linux', () => {
  const win = candidateLogPaths('win32', 'C:\\Users\\test')
  assert.ok(win.some(p => p.includes('Grinding Gear Games\\Path of Exile 2\\logs\\Client.txt')))
  assert.ok(win.some(p => p.includes('Steam\\steamapps\\common\\Path of Exile 2\\logs\\Client.txt')))
  assert.ok(win.some(p => p.includes('SteamLibrary\\steamapps\\common\\Path of Exile 2\\logs\\Client.txt')), 'Windows SteamLibrary fallback present')

  const mac = candidateLogPaths('darwin', '/Users/test')
  assert.ok(mac.some(p => p.includes('Library/Caches/com.GGG.PathOfExile/Logs/Client.txt')))
  assert.ok(mac.some(p => p.includes('Library/Application Support/Steam/steamapps/common/Path of Exile 2/logs/Client.txt')), 'macOS Steam fallback present')

  const lin = candidateLogPaths('linux', '/home/test')
  assert.ok(lin.some(p => p.includes('.steam/steam/steamapps/common/Path of Exile 2/logs/Client.txt')))
})

test('LogWatcher tails appended lines, buffers split lines across ticks, recovers from truncation/rotation, and degrades silently when missing', async () => {
  const missing = new LogWatcher({ filePath: '/nonexistent/path/to/Client.txt', onLine: () => {} })
  assert.equal(await missing.start(), null, 'absent Client.txt degrades silently to null')
  missing.stop()

  const dir = mkdtempSync(join(tmpdir(), 'arbiter-client-log-'))
  const file = join(dir, 'Client.txt')
  writeFileSync(file, P + ': You have entered Old History.\n', 'utf8')

  const seen = []
  const w = new LogWatcher({ filePath: file, intervalMs: 50, onLine: (l) => seen.push(l) })
  try {
    assert.equal(await w.start(), file)
    // Appended line after start
    appendFileSync(file, P + ': You have entered Crypt.\n', 'utf8')
    await new Promise((res, rej) => {
      const deadline = Date.now() + 2500
      const check = () => {
        if (seen.some(l => l.includes('Crypt'))) return res()
        if (Date.now() > deadline) return rej(new Error(`timed out waiting for appended line; seen=${JSON.stringify(seen)}`))
        setTimeout(check, 40)
      }
      check()
    })
    assert.ok(!seen.some(l => l.includes('Old History')), 'starts at EOF and skips history')

    // Partial line written across two poll ticks (C10) must be reassembled, never emitted split or dropped
    const splitFull = P + 'Generating level 81 area "MapBurialBog" with seed 777888'
    appendFileSync(file, splitFull.slice(0, 35), 'utf8')
    await new Promise(r => { setTimeout(r, 140) })
    assert.ok(!seen.some(l => l.includes('MapBurialBog')), 'incomplete line waits for newline')
    appendFileSync(file, splitFull.slice(35) + '\n', 'utf8')
    await new Promise((res, rej) => {
      const deadline = Date.now() + 2500
      const check = () => {
        if (seen.includes(splitFull)) return res()
        if (Date.now() > deadline) return rej(new Error(`timed out waiting for reassembled split line; seen=${JSON.stringify(seen)}`))
        setTimeout(check, 40)
      }
      check()
    })

    // Truncate / rotate the file to a smaller size than previous offset, then write a short line
    writeFileSync(file, P + ': AFK mode is now ON.\n', 'utf8')
    await new Promise((res, rej) => {
      const deadline = Date.now() + 2500
      const check = () => {
        if (seen.some(l => l.includes('AFK mode is now ON'))) return res()
        if (Date.now() > deadline) return rej(new Error(`timed out waiting for post-truncation line; seen=${JSON.stringify(seen)}`))
        setTimeout(check, 40)
      }
      check()
    })
  } finally {
    w.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('main.js and preload.js wire Client.txt watcher cleanly while server-watcher stays dormant', () => {
  const ROOT = new URL('../../', import.meta.url).pathname
  const main = readFileSync(ROOT + 'desktop/src/main.js', 'utf8')
  const preload = readFileSync(ROOT + 'desktop/src/preload.js', 'utf8')

  assert.ok(main.includes('log-watcher.js') && main.includes('client-log-parser.js'), 'main.js requires log-watcher and parser')
  assert.ok(main.includes('startClientLogWatcher()') && main.includes('stopClientLogWatcher()'), 'lifecycle started on ready and stopped on quit')
  assert.ok(main.indexOf('startClientLogWatcher()') < main.indexOf('win.loadURL(uiUrl)'), 'startClientLogWatcher starts before win.loadURL to avoid initial status race')
  assert.ok(main.includes("'client-log:event'") && main.includes("'client-log:status'"), 'IPC channels wired')
  assert.ok(main.includes('_clientLogStartPromise') && main.includes("win?.webContents.send('client-log:status'"), 'client-log:status awaits startup promise and pushes ready notification')
  assert.ok(main.includes("ipcMain.handle('dev:client-log-line'") && main.includes('diagTelemetryOn()'), 'DEV injection gated by diagTelemetryOn()')
  assert.ok(main.includes('toRendererEvent('), 'main.js filters events via safe allowlist so whispers never cross IPC')
  assert.ok(!main.includes("console.log('[client-log] watching:', _clientLogPath)"), 'never log raw Client.txt path with OS username into mainRing')
  assert.ok(preload.includes("clientLog:") && preload.includes("sub('client-log:event')") && preload.includes("sub('client-log:status')") && preload.includes("ipcRenderer.invoke('client-log:status')"), 'preload exposes clientLog event, status push, and status invoke')
  assert.ok(preload.includes("clientLogLine:") && preload.includes("ipcRenderer.invoke('dev:client-log-line'"), 'preload exposes dev.clientLogLine')

  // Nothing in the app probes EE2's own server: no GET /config poll and never its /events websocket (a
  // client there becomes EE2's "last-active" client and diverts its price-check results). The optional
  // server-watcher.js that did the /config probe was deleted unwired; this keeps any copy of it out.
  const SRC = ROOT + 'desktop/src/'
  for (const f of readdirSync(SRC, { recursive: true })) {
    if (!String(f).endsWith('.js') || String(f).startsWith('vendor/')) continue
    const text = readFileSync(SRC + f, 'utf8')
    assert.ok(!/path:\s*['"`]\/config['"`]/.test(text), `${f} probes EE2's /config`)
    assert.ok(!/\/events['"`]/.test(text), `${f} names EE2's /events socket`)
  }
})
