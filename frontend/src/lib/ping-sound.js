// Notification tones. Real recordings from Kenney's CC0 "Interface Sounds" pack
// (public/sounds/LICENSE.txt), loudness-normalised at encode time so no tone is a surprise.
// Played through WebAudio (decoded once, cached) so a ping sounds EVEN WHEN THE WINDOW IS
// UNFOCUSED/HIDDEN — WebAudio is not subject to the hidden-tab rAF/animation freeze. Deduped +
// throttled so a burst coalesces into one ding. Whether it plays at all, which tone, and how
// loud is decided by the caller (lib/notifications.js).
let ctx = null
let lastPlay = 0
const MIN_GAP_MS = 1500
const buffers = new Map()      // tone id -> AudioBuffer (decoded once)

export const TONES = {
  confirm:  { label: 'Confirm',  file: '/sounds/confirm.m4a' },
  glass:    { label: 'Glass',    file: '/sounds/glass.m4a' },
  pluck:    { label: 'Pluck',    file: '/sounds/pluck.m4a' },
  question: { label: 'Question', file: '/sounds/question.m4a' },
  bong:     { label: 'Bong',     file: '/sounds/bong.m4a' },
  drop:     { label: 'Drop',     file: '/sounds/drop.m4a' },
  open:     { label: 'Open',     file: '/sounds/open.m4a' },
  rise:     { label: 'Rise',     file: '/sounds/rise.m4a' },
}
export const DEFAULT_TONE = 'confirm'
export const DEFAULT_VOLUME = 0.3

function audioContext() {
  ctx = ctx || new (window.AudioContext || window.webkitAudioContext)()
  if (ctx.state === 'suspended') ctx.resume()
  return ctx
}

// Browser autoplay policy: the audio context must be resumed inside a user gesture.
// Call once from a click/keydown handler early in the app's life.
export function unlockSound() {
  try { audioContext() } catch {}
}

async function bufferFor(tone) {
  const spec = TONES[tone] || TONES[DEFAULT_TONE]
  if (buffers.has(spec.file)) return buffers.get(spec.file)
  const res = await fetch(spec.file)
  const buf = await audioContext().decodeAudioData(await res.arrayBuffer())
  buffers.set(spec.file, buf)
  return buf
}

// volume 0..1 (settings.notifications.volume). `preview` skips the burst coalescer.
export function playPing(volume = DEFAULT_VOLUME, tone = DEFAULT_TONE, { preview = false } = {}) {
  const now = Date.now()
  if (!preview && now - lastPlay < MIN_GAP_MS) return
  lastPlay = now
  bufferFor(tone).then(buf => {
    const c = audioContext()
    const src = c.createBufferSource()
    const gain = c.createGain()
    gain.gain.value = Math.max(0, Math.min(1, volume))
    src.buffer = buf
    src.connect(gain); gain.connect(c.destination)
    src.start()
  }).catch(() => {})
}
