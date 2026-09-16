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

// The tone palette: each is a tiny synthesised motif — [frequency Hz, start s, duration s] notes
// on one waveform — so the two notification families can be told apart by ear. Picked per family
// in Settings → Notifications; `DEFAULT_TONE` is the original Vaal-implosion chime.
export const TONES = {
  vaal:  { label: 'Vaal chime',  wave: 'triangle', notes: [[196, 0, 0.14], [392, 0.09, 0.22], [523.25, 0.17, 0.3]] },   // G3→G4→C5, rising
  coin:  { label: 'Coin drop',   wave: 'sine',     notes: [[1046.5, 0, 0.08], [1318.5, 0.06, 0.1], [1568, 0.12, 0.22]] },  // bright, fast arpeggio
  bell:  { label: 'Bell',        wave: 'sine',     notes: [[880, 0, 0.5], [1760, 0, 0.25]] },                             // one struck bell + overtone
  drop:  { label: 'Two-tone drop', wave: 'triangle', notes: [[659.25, 0, 0.14], [440, 0.14, 0.3]] },                      // E5→A4, falling
  pulse: { label: 'Pulse',       wave: 'square',   notes: [[523.25, 0, 0.06], [523.25, 0.12, 0.06], [523.25, 0.24, 0.12]] }, // three short blips
  horn:  { label: 'Low horn',    wave: 'sawtooth', notes: [[130.81, 0, 0.35], [164.81, 0.18, 0.4]] },                    // C3+E3, low and long
}
export const DEFAULT_TONE = 'vaal'

export function playPing(volume = 0.5, tone = DEFAULT_TONE, { preview = false } = {}) {
  const now = Date.now()
  if (!preview && now - lastPlay < MIN_GAP_MS) return   // coalesce bursts (previews always play)
  lastPlay = now
  const spec = TONES[tone] || TONES[DEFAULT_TONE]
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)()
    if (ctx.state === 'suspended') ctx.resume()
    const t = ctx.currentTime
    const master = ctx.createGain()
    master.gain.value = Math.max(0, Math.min(1, volume))
    master.connect(ctx.destination)
    for (const [freq, start, dur] of spec.notes) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = spec.wave
      o.frequency.setValueAtTime(freq, t + start)
      g.gain.setValueAtTime(0.0001, t + start)
      g.gain.exponentialRampToValueAtTime(0.9, t + start + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur)
      o.connect(g); g.connect(master)
      o.start(t + start); o.stop(t + start + dur + 0.02)
    }
  } catch {}
}

