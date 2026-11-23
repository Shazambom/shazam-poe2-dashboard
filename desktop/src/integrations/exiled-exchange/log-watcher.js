// Passive observer: tail the Path of Exile 2 client log (Client.txt).
//
// Reads only locally-appended lines without touching the game process. If the
// log file isn't present in any candidate location, degrades silently to null —
// never an error.
'use strict'
const { ignored } = require('../../ignored.js')

const fs = require('node:fs')
const fsp = fs.promises
const os = require('node:os')
const path = require('node:path')
const { StringDecoder } = require('node:string_decoder')

// Common install locations for PoE2's Client.txt (standalone + Steam), per
// platform. Accepts optional (platform, home) for deterministic testing.
function candidateLogPaths(platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') {
    const winSteamLibs = ['C:', 'D:', 'E:', 'F:'].map(
      (d) => `${d}\\SteamLibrary\\steamapps\\common\\Path of Exile 2\\logs\\Client.txt`,
    )
    return [
      'C:\\Program Files (x86)\\Grinding Gear Games\\Path of Exile 2\\logs\\Client.txt',
      'C:\\Program Files\\Grinding Gear Games\\Path of Exile 2\\logs\\Client.txt',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Path of Exile 2\\logs\\Client.txt',
      'C:\\Program Files\\Steam\\steamapps\\common\\Path of Exile 2\\logs\\Client.txt',
      'D:\\Steam\\steamapps\\common\\Path of Exile 2\\logs\\Client.txt',
      'D:\\Program Files (x86)\\Steam\\steamapps\\common\\Path of Exile 2\\logs\\Client.txt',
      ...winSteamLibs,
    ]
  }
  if (platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Caches', 'com.GGG.PathOfExile', 'Logs', 'Client.txt'),
      path.join(home, 'Library', 'Application Support', 'Steam', 'steamapps', 'common', 'Path of Exile 2', 'logs', 'Client.txt'),
    ]
  }
  // Linux (Steam/Proton).
  return [
    path.join(home, '.steam', 'steam', 'steamapps', 'common', 'Path of Exile 2', 'logs', 'Client.txt'),
    path.join(home, '.local', 'share', 'Steam', 'steamapps', 'common', 'Path of Exile 2', 'logs', 'Client.txt'),
  ]
}

async function exists(p) {
  try { await fsp.access(p, fs.constants.R_OK); return true } catch { return false }
}

async function findLog() {
  for (const p of candidateLogPaths()) {
    if (await exists(p)) return p
  }
  return null
}

// Tails Client.txt and calls onLine(text) for each newly-appended complete line. Polls
// file size asynchronously against our tracked byte offset and buffers incomplete trailing
// lines until a newline arrives so split writes are never dropped or truncated.
class LogWatcher {
  /** @param {{ intervalMs?: number, onLine?: (line: string) => void, filePath?: string | null }} [opts] */
  constructor({ intervalMs = 1000, onLine, filePath = null } = {}) {
    this._intervalMs = Math.max(intervalMs, 50)
    this._onLine = typeof onLine === 'function' ? onLine : () => {}
    this._explicitPath = filePath
    this._file = null
    this._offset = 0
    this._partial = ''
    this._decoder = new StringDecoder('utf8')
    this._timer = null
    this._reading = false
    this._pendingRead = false
    this._stopped = false
  }

  // Returns Promise<string|null>: the resolved log path if watching started, else null.
  async start() {
    if (this._file) return this._file
    this._stopped = false
    const file = this._explicitPath
      ? ((await exists(this._explicitPath)) ? this._explicitPath : null)
      : await findLog()
    if (!file || this._stopped) return null
    let size
    try { size = (await fsp.stat(file)).size } catch { size = 0 }
    if (this._stopped) return null
    this._file = file
    // Start at end-of-file so we only report activity from now on, not history.
    this._offset = size
    this._partial = ''
    this._decoder = new StringDecoder('utf8')
    this._timer = setInterval(() => { this._readAppended() }, this._intervalMs)
    if (this._timer.unref) this._timer.unref()
    return file
  }

  stop() {
    this._stopped = true
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    this._file = null
    this._offset = 0
    this._partial = ''
    this._decoder = new StringDecoder('utf8')
    this._reading = false
    this._pendingRead = false
  }

  async _readAppended() {
    const file = this._file
    if (!file) return
    if (this._reading) { this._pendingRead = true; return }
    this._reading = true
    this._pendingRead = false
    let end = this._offset
    try {
      end = (await fsp.stat(file)).size
    } catch {
      this._reading = false
      return
    }
    if (this._file !== file) { this._reading = false; return }
    if (end < this._offset) {
      // Truncated/rotated: reset offset and discard any partial fragment from the old file.
      this._offset = 0
      this._partial = ''
      this._decoder = new StringDecoder('utf8')
    }
    const done = () => {
      this._reading = false
      if (this._pendingRead && this._file === file) {
        this._pendingRead = false
        this._readAppended()
      }
    }
    if (end <= this._offset) {
      done()
      return
    }
    const start = this._offset
    const stream = fs.createReadStream(file, { start, end: end - 1 })
    let text = ''
    stream.on('data', (chunk) => { text += this._decoder.write(chunk) })
    stream.on('end', () => {
      if (this._file !== file) { this._reading = false; return }
      this._offset = end
      const combined = this._partial + text
      const parts = combined.split(/\r?\n/)
      this._partial = parts.pop() || ''
      for (const line of parts) {
        const t = line.trim()
        if (t) { try { this._onLine(t) } catch (e) { ignored('client-log:on-line', e) } }
      }
      done()
    })
    stream.on('error', () => { done() })
  }
}

module.exports = { LogWatcher, candidateLogPaths }
