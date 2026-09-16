// Notification tones: CC0 (public-domain) recordings — the best-rated, most-downloaded CC0
// notification/chime sounds on Freesound plus CreatorAssets' CC0 modern chimes (sources, ratings
// and licences in public/sounds/LICENSE.txt) — loudness-normalised at encode time so no tone is
// a surprise.
// Played through WebAudio (decoded once, cached) so a ping sounds EVEN WHEN THE WINDOW IS
// UNFOCUSED/HIDDEN — WebAudio is not subject to the hidden-tab rAF/animation freeze. Deduped +
// throttled so a burst coalesces into one ding. Whether it plays at all, which tone, and how
// loud is decided by the caller (lib/notifications.js).
let ctx = null
let lastPlay = 0
const MIN_GAP_MS = 1500
const buffers = new Map()      // tone id -> AudioBuffer (decoded once)

export const TONES = {
  chime:    { label: "Chime", file: '/sounds/chime.m4a' },
  pop:      { label: "Pop-up", file: '/sounds/pop.m4a' },
  notify:   { label: "Notification", file: '/sounds/notify.m4a' },
  bell:     { label: "Bell chime", file: '/sounds/bell.m4a' },
  beep:     { label: "Beep ping", file: '/sounds/beep.m4a' },
  dingdong: { label: "Soft ding-dong", file: '/sounds/dingdong.m4a' },
  pup:      { label: "Pup alert", file: '/sounds/pup.m4a' },
  elevator: { label: "Elevator ping", file: '/sounds/elevator.m4a' },
  chime2:   { label: "Chime (long)", file: '/sounds/chime2.m4a' },
  alert:    { label: "UI alert", file: '/sounds/alert.m4a' },
  scifi:    { label: "Sci-fi ping", file: '/sounds/scifi.m4a' },
  notify2:  { label: "Notification 2", file: '/sounds/notify2.m4a' },
  soft1:    { label: "Modern 1", file: '/sounds/soft1.m4a' },
  soft2:    { label: "Modern 2", file: '/sounds/soft2.m4a' },
  soft3:    { label: "Modern 3", file: '/sounds/soft3.m4a' },
  soft4:    { label: "Modern 4", file: '/sounds/soft4.m4a' },
  soft5:    { label: "Modern 5", file: '/sounds/soft5.m4a' },
}
export const DEFAULT_TONE = 'chime'
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
