// The ping "ding". Synthesised with WebAudio (no bundled asset), fires EVEN WHEN THE WINDOW IS
// UNFOCUSED/HIDDEN — WebAudio/HTMLAudio are not subject to the hidden-tab rAF/animation freeze,
// so this is correct by construction. Deduped + throttled so a burst coalesces into one ding.
// Whether it plays at all, and how loud, is decided by the caller (lib/notifications.js).
let ctx = null
let unlocked = false
let lastPlay = 0
const MIN_GAP_MS = 1500

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
export function playPing(volume = 0.5) {
  const now = Date.now()
  if (now - lastPlay < MIN_GAP_MS) return           // coalesce bursts
  lastPlay = now
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)()
    if (ctx.state === 'suspended') ctx.resume()
    const t = ctx.currentTime
    const master = ctx.createGain()
    master.gain.value = Math.max(0, Math.min(1, volume))
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

