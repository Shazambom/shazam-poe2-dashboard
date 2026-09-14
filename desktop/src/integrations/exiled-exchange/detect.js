// Best-effort detection of Exiled-Exchange-2 on this machine.
//
// Why "best-effort": EE2 is a separate app we don't own. We never want its
// presence (or absence) to break ShazamDash, and we never spawn/kill it. This is
// purely so the integration can tell the difference between "EE2 is here, the
// clipboard signal is meaningful" and "EE2 isn't installed, clipboard hits are
// probably someone else copying item text" — a hint, not a gate.
//
// Two cheap, read-only signals:
//   1. EE2's config dir on disk (Electron userData → "exiled-exchange-2").
//      This is the strongest offline signal and needs no process spawn.
//   2. A running process whose name looks like EE2 (secondary; requires shelling
//      out to tasklist/ps, so it's optional and fully guarded).
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

// Candidate config directories per platform. EE2 stores config under an Electron
// userData dir named "exiled-exchange-2" (confirmed by EE2 main/src/host-files/
// ConfigStore.ts writing "apt-data/config.json" under app.getPath('userData')).
function configDirs() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    return [path.join(appdata, 'exiled-exchange-2')]
  }
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'exiled-exchange-2')]
  }
  // Linux (and anything else): XDG config, plus the common ~/.config fallback.
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  return [path.join(xdg, 'exiled-exchange-2')]
}

function findConfig() {
  for (const dir of configDirs()) {
    const cfg = path.join(dir, 'apt-data', 'config.json')
    try { if (fs.existsSync(cfg)) return { dir, config: cfg } } catch {}
    try { if (fs.existsSync(dir)) return { dir, config: null } } catch {}
  }
  return null
}

// Optional secondary check: is an EE2-looking process running right now? Guarded,
// time-limited, and swallows every error — a failure here just means "unknown".
function findProcess() {
  return new Promise((resolve) => {
    const done = (v) => resolve(v)
    try {
      if (process.platform === 'win32') {
        execFile('tasklist', { timeout: 2000 }, (err, out) => {
          if (err || !out) return done(false)
          done(/exiled.?exchange/i.test(out))
        })
      } else {
        execFile('ps', ['-A', '-o', 'comm'], { timeout: 2000 }, (err, out) => {
          if (err || !out) return done(false)
          done(/exiled.?exchange/i.test(out))
        })
      }
    } catch { done(false) }
  })
}

// Returns { present, method, dir, config, running }. Never throws.
async function detectEE2({ checkProcess = false } = {}) {
  const cfg = findConfig()
  let running = false
  if (checkProcess) { try { running = await findProcess() } catch {} }
  const present = Boolean(cfg) || running
  return {
    present,
    method: cfg ? 'config-dir' : (running ? 'process' : 'none'),
    dir: cfg ? cfg.dir : null,
    config: cfg ? cfg.config : null,
    running,
  }
}

module.exports = { detectEE2, configDirs }
