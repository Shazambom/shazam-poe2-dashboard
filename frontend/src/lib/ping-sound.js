// The live-ping "ding". Synthesised with WebAudio (no bundled asset), fires on every new
// ping EVEN WHEN THE WINDOW IS UNFOCUSED/HIDDEN — WebAudio/HTMLAudio are not subject to
// the hidden-tab rAF/animation freeze, so this is correct by construction. Deduped +
// throttled so a burst coalesces into one ding. Mutable via settings.
import { api } from './api.js'

let ctx = null
let unlocked = false
let lastPlay = 0
let prefs = { on: true, volume: 0.5 }
const MIN_GAP_MS = 1500

// Load persisted prefs once (settings kv).
api.settings().then(s => {
  if (s && typeof s.ping_sound === 'boolean') prefs.on = s.ping_sound
  if (s && typeof s.ping_volume === 'number') prefs.volume = s.ping_volume
}).catch(() => {})

export function setSoundPrefs(patch) { prefs = { ...prefs, ...patch } }
export function getSoundPrefs() { return { ...prefs } }

// Browser autoplay policy: the audio context must be resumed inside a user gesture.
// Call once from a click/keydown handler early in the app's life.
export function unlockSound() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)()
    if (ctx.state === 'suspended') ctx.resume()
    unlocked = true
  } catch {}
}

// A short two-note "corruption" chime — a low detuned tone into a brighter one, like a
// Vaal implosion. Kept tiny.
export function playPing() {
  if (!prefs.on) return
  const now = Date.now()
  if (now - lastPlay < MIN_GAP_MS) return           // coalesce bursts
  lastPlay = now
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)()
    if (ctx.state === 'suspended') ctx.resume()
    const t = ctx.currentTime
    const master = ctx.createGain()
    master.gain.value = Math.max(0, Math.min(1, prefs.volume))
    master.connect(ctx.destination)
    const notes = [[196, 0, 0.14], [392, 0.09, 0.22], [523.25, 0.17, 0.3]]  // G3 -> G4 -> C5
    for (const [freq, start, dur] of notes) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'triangle'
      o.frequency.setValueAtTime(freq, t + start)
      g.gain.setValueAtTime(0.0001, t + start)
      g.gain.exponentialRampToValueAtTime(0.9, t + start + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur)
      o.connect(g); g.connect(master)
      o.start(t + start); o.stop(t + start + dur + 0.02)
    }
  } catch {}
}

export function soundReady() { return unlocked }
