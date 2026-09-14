// OPTIONAL secondary observer: tail the Path of Exile 2 client log.
//
// Why this exists: EE2's most useful non-clipboard signal is the GAME'S OWN log
// file, Client.txt — EE2 watches it too (main/src/host-files/GameLogWatcher.ts)
// to know which zone you're in, whom you whispered, trade-chat, etc. It's a
// passive, append-only file we can read without touching EE2 or the game. It does
// NOT tell us about price checks (those never hit the log), so it's complementary
// to the clipboard watcher, not a replacement.
//
// This is feature-flagged OFF by default because it opens a file handle / polling
// timer on a path we can only guess at. If the file isn't where we look, we
// degrade to silence — never an error.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

// Common install locations for PoE2's Client.txt (standalone + Steam), per
// platform. Mirrors where EE2 looks, but the list is ours.
function candidateLogPaths() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files (x86)\\Grinding Gear Games\\Path of Exile 2\\logs\\Client.txt',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Path of Exile 2\\logs\\Client.txt',
      'C:\\Program Files\\Steam\\steamapps\\common\\Path of Exile 2\\logs\\Client.txt',
    ]
  }
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Caches', 'com.GGG.PathOfExile', 'Logs', 'Client.txt')]
  }
  // Linux (Steam/Proton).
  return [
    path.join(home, '.steam', 'steam', 'steamapps', 'common', 'Path of Exile 2', 'logs', 'Client.txt'),
  ]
}

function findLog() {
  for (const p of candidateLogPaths()) {
    try { if (fs.existsSync(p)) return p } catch {}
  }
  return null
}

// Tails Client.txt and calls onLine(text) for each newly-appended line. Uses
// fs.watchFile polling (like EE2) because Client.txt is written by another
// process and native fs.watch is unreliable across platforms for that.
class LogWatcher {
  constructor({ intervalMs = 1000, onLine } = {}) {
    this._intervalMs = Math.max(intervalMs, 450)
    this._onLine = typeof onLine === 'function' ? onLine : () => {}
    this._file = null
    this._offset = 0
    this._listener = null
  }

  // Returns the resolved log path if watching started, else null.
  start() {
    if (this._file) return this._file
    const file = findLog()
    if (!file) return null
    this._file = file
    // Start at end-of-file so we only report activity from now on, not history.
    try { this._offset = fs.statSync(file).size } catch { this._offset = 0 }
    this._listener = (curr) => { if (curr.size > this._offset) this._readAppended() }
    fs.watchFile(file, { interval: this._intervalMs }, this._listener)
    return file
  }

  stop() {
    if (this._file && this._listener) {
      try { fs.unwatchFile(this._file, this._listener) } catch {}
    }
    this._file = null
    this._listener = null
    this._offset = 0
  }

  _readAppended() {
    const file = this._file
    let end = this._offset
    try { end = fs.statSync(file).size } catch { return }
    if (end <= this._offset) { this._offset = end; return }  // truncated/rotated
    const stream = fs.createReadStream(file, { start: this._offset, end: end - 1, encoding: 'utf8' })
    let buf = ''
    stream.on('data', (d) => { buf += d })
    stream.on('end', () => {
      this._offset = end
      for (const line of buf.split(/\r?\n/)) {
        const t = line.trim()
        if (t) { try { this._onLine(t) } catch {} }
      }
    })
    stream.on('error', () => {})
  }
}

module.exports = { LogWatcher, candidateLogPaths }
