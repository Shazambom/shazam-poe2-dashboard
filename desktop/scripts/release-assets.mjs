#!/usr/bin/env node
// Release assets, done safely — the ONE tool both halves of a release use (Windows CI and
// publish-github.sh), so the two can't drift. Fixes docs/bugs/2026-09-17-release-publish-not-atomic.md:
//
//   ensure-draft <tag> <sha>      create the release as a DRAFT (invisible to electron-updater, never
//                                 "Latest") targeting <sha>, unless one already exists. The TAG IS
//                                 NOT PUSHED: publishing the draft creates it, so clients never see
//                                 a tag without its release (releases.atom lists bare tags)
//   has <tag> <asset>             exit 0 if that asset is fully uploaded (lets a re-run skip CI)
//   upload <tag> <files...>       installers first, update manifests (*.yml) LAST; per file: clear a
//                                 half-created ("starter") asset, stream it up while WATCHING THE
//                                 SPEED — a connection that collapses is cut and retried on a fresh
//                                 one — and trust only the asset's state+sha256, never an exit code
//   verify <tag> [--live]         every file named by every channel manifest is on the release,
//                                 state "uploaded", at the manifest's size; --live also GETs each
//                                 public download URL for a 200
//   publish <tag>                 verify → flip the draft public (the single go-live moment) →
//                                 verify --live → on failure ROLL BACK (re-draft) so clients stay
//                                 on the previous version
//
// Needs `gh` (authenticated; GH_TOKEN in CI). Zero npm deps.
import { spawn } from 'node:child_process'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = 'Shazambom/shazam-poe2-dashboard'
const UPLOAD_TIMEOUT_MS = Number(process.env.RELEASE_UPLOAD_TIMEOUT_MS || 20 * 60 * 1000)   // hard cap per attempt
const UPLOAD_TRIES = Number(process.env.RELEASE_UPLOAD_TRIES || 6)
// Cut-our-losses rule (0.2.61-beta.1: one connection sank to ~47 KB/s and burned 20 min; the retry
// on a fresh connection landed the same 182 MB in about a minute). Healthy is 1.5 MB/s+.
export const STALL = {
  minBps: Number(process.env.RELEASE_MIN_KBPS || 300) * 1024,   // slower than this, averaged over…
  windowMs: Number(process.env.RELEASE_STALL_WINDOW_MS || 30000),  // …this long = a dead connection
  responseMs: 5 * 60 * 1000,                                    // all bytes sent, GitHub still silent
}

export const isBeta = (tag) => /-beta/.test(tag)
export const isManifest = (name) => /\.ya?ml$/i.test(name)
export const versionOf = (tag) => tag.replace(/^desktop-v/, '')
// The channel manifests a COMPLETE release must carry (one per platform).
export const expectedManifests = (tag) => (isBeta(tag) ? ['beta.yml', 'beta-mac.yml'] : ['latest.yml', 'latest-mac.yml'])

// Installers/blockmaps first, manifests last: a manifest is what clients act on, so it may only
// appear once everything it names is already there.
export function uploadOrder(files) {
  const rank = (f) => (isManifest(f) ? 1 : 0)
  return [...files].sort((a, b) => rank(a) - rank(b))
}

// electron-builder's update manifest → [{name, size}] for every file it names (`files:` + `path:`).
// A tiny purpose-built reader (the format is fixed and flat), so no yaml dependency.
export function manifestFiles(text) {
  const out = new Map()
  let cur = null
  for (const raw of text.split(/\r?\n/)) {
    let m
    if ((m = raw.match(/^\s*-\s*url:\s*(\S+)/))) { cur = { name: m[1], size: null }; out.set(cur.name, cur) }
    else if (cur && (m = raw.match(/^\s+size:\s*(\d+)/))) cur.size = Number(m[1])
    else if ((m = raw.match(/^path:\s*(\S+)/))) { if (!out.has(m[1])) out.set(m[1], { name: m[1], size: null }) }
    if (/^\S/.test(raw) && !/^files:/.test(raw)) cur = null
  }
  return [...out.values()]
}

// Pure check: problems (strings) with a release's assets given its manifests' contents.
// `assets` = [{name,state,size}], `manifests` = {name: text}. Empty list = good to go live.
export function problems(tag, assets, manifests) {
  const by = new Map(assets.map((a) => [a.name, a]))
  const bad = []
  const need = (name, size, why) => {
    const a = by.get(name)
    if (!a) bad.push(`${name}: missing (${why})`)
    else if (a.state !== 'uploaded') bad.push(`${name}: state "${a.state}" (${why})`)
    else if (size != null && a.size !== size) bad.push(`${name}: size ${a.size} != ${size} (${why})`)
  }
  for (const m of expectedManifests(tag)) {
    need(m, null, 'channel manifest')
    if (manifests[m] == null) continue
    const files = manifestFiles(manifests[m])
    if (!files.length) bad.push(`${m}: names no files`)
    for (const f of files) need(f.name, f.size, `named by ${m}`)
  }
  // The Mac in-app update opens this DMG in the browser (main.js macDmgUrl) — it is part of the
  // update path even if a manifest ever stops listing it.
  need(`Arbiter-${versionOf(tag)}-arm64.dmg`, null, 'Mac manual-update link')
  for (const a of assets) if (a.state !== 'uploaded') bad.push(`${a.name}: state "${a.state}" (half-created asset)`)
  return [...new Set(bad)]
}

// Pure: has the upload's speed collapsed? `samples` = [{t, bytes}] (ms, cumulative bytes sent),
// oldest first. True once a full window of history exists and the average over the last window
// is under the floor. Never true once every byte is out (then only the response is pending).
export function stalled(samples, total, { minBps, windowMs } = STALL) {
  if (samples.length < 2) return false
  const last = samples[samples.length - 1]
  if (last.bytes >= total) return false
  const from = samples.findLast((s) => last.t - s.t >= windowMs)
  if (!from) return false                                  // not a full window yet
  return ((last.bytes - from.bytes) * 1000) / (last.t - from.t) < minBps
}

// ---- gh plumbing -----------------------------------------------------------------------------
function run(cmd, args, { timeout = 120000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = '', timedOut = false
    const t = setTimeout(() => { timedOut = true; p.kill('SIGKILL') }, timeout)
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d))
    p.on('error', (e) => { clearTimeout(t); resolve({ code: 127, out, err: String(e), timedOut }) })
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err, timedOut }) })
  })
}
const gh = (args, opts) => run('gh', args, opts)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// The release for a tag, drafts included (the /releases/tags/<tag> endpoint can't see drafts).
async function findRelease(tag) {
  const r = await gh(['api', `repos/${REPO}/releases?per_page=100`])
  if (r.code !== 0) throw new Error(`cannot list releases: ${r.err.trim()}`)
  const hits = JSON.parse(r.out).filter((x) => x.tag_name === tag)
  if (hits.length > 1) throw new Error(`${hits.length} releases share tag ${tag} (ids ${hits.map((h) => h.id).join(', ')}) — delete the stray draft`)
  return hits[0] || null
}
async function assetsOf(id) {
  const r = await gh(['api', `repos/${REPO}/releases/${id}/assets?per_page=100`])
  if (r.code !== 0) throw new Error(`cannot list assets: ${r.err.trim()}`)
  return JSON.parse(r.out).map(({ id, name, state, size, digest }) => ({ id, name, state, size, digest }))
}
const deleteAsset = (id) => gh(['api', '-X', 'DELETE', `repos/${REPO}/releases/assets/${id}`])

async function ensureDraft(tag, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('ensure-draft needs the full commit sha the tag will point at')
  const have = await findRelease(tag)
  if (have) {
    console.log(`release ${tag} exists (${have.draft ? 'draft' : 'PUBLISHED'}, id ${have.id})`)
    if (have.draft && have.target_commitish !== sha) {     // a re-run after a new commit: retarget
      const r = await gh(['release', 'edit', tag, '--repo', REPO, '--target', sha])
      if (r.code !== 0) throw new Error(`cannot retarget draft: ${r.err.trim()}`)
      console.log(`  retargeted ${have.target_commitish} → ${sha}`)
    }
    return have
  }
  const args = ['release', 'create', tag, '--repo', REPO, '--draft', '--title', tag, '--notes', '', '--target', sha]
  if (isBeta(tag)) args.push('--prerelease')
  const r = await gh(args)
  if (r.code !== 0) throw new Error(`cannot create draft: ${r.err.trim()}`)
  console.log(`created draft release ${tag}`)
  return findRelease(tag)
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(`sha256:${h.digest('hex')}`))
  })
}

let _token
async function token() {
  if (_token) return _token
  _token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || (await gh(['auth', 'token'])).out.trim()
  if (!_token) throw new Error('no GitHub token (set GH_TOKEN or run `gh auth login`)')
  return _token
}

// Stream one file to the release's upload URL, sampling bytes-on-the-wire every 2 s.
// Resolves {ok, why}: never throws, and never decides success — the caller asks GitHub.
async function streamUp(rel, file, name, size) {
  const auth = await token()
  return new Promise((resolve) => {
    const url = new URL(rel.upload_url.replace(/\{.*$/, ''))
    url.searchParams.set('name', name)
    const req = https.request(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/octet-stream', 'Content-Length': size,
                 Accept: 'application/vnd.github+json', 'User-Agent': 'arbiter-release-assets' },
    })
    const started = Date.now(), samples = [{ t: started, bytes: 0 }]
    let done = false, sentAllAt = 0
    const finish = (ok, why) => { if (done) return; done = true; clearInterval(tick); req.destroy(); src.destroy(); resolve({ ok, why }) }
    const src = createReadStream(file, { highWaterMark: 256 * 1024 })
    const tick = setInterval(() => {
      const now = Date.now(), bytes = Math.max(0, (req.socket?.bytesWritten || 0))
      samples.push({ t: now, bytes: Math.min(bytes, size) })
      if (samples.length > 600) samples.shift()
      if (bytes >= size && !sentAllAt) sentAllAt = now
      if (stalled(samples, size)) {
        const from = samples.findLast((s) => now - s.t >= STALL.windowMs)
        const kbps = Math.round(((bytes - from.bytes) * 1000) / (now - from.t) / 1024)
        return finish(false, `speed collapsed to ${kbps} KB/s at ${Math.round((bytes / size) * 100)}% — cutting the connection`)
      }
      if (sentAllAt && now - sentAllAt > STALL.responseMs) return finish(false, 'all bytes sent but no response')
      if (now - started > UPLOAD_TIMEOUT_MS) return finish(false, 'hard timeout')
    }, 2000)
    req.on('response', (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => finish(res.statusCode === 201, `HTTP ${res.statusCode} ${body.slice(0, 160).replace(/\s+/g, ' ')}`))
    })
    req.on('error', (e) => finish(false, `connection error: ${e.message}`))
    src.on('error', (e) => finish(false, `read error: ${e.message}`))
    src.pipe(req)
  })
}

async function uploadOne(rel, file) {
  const name = basename(file), size = statSync(file).size, digest = await sha256(file)
  // Landed = GitHub holds exactly these bytes (its own sha256 of the asset; size if it reports none).
  const landed = (a) => a && a.state === 'uploaded' && a.size === size && (!a.digest || a.digest === digest)
  for (let attempt = 1; attempt <= UPLOAD_TRIES; attempt++) {
    const old = (await assetsOf(rel.id)).find((a) => a.name === name)
    if (landed(old)) { console.log(`  ${name}: already uploaded (${size} bytes)`); return }
    if (old) { console.log(`  ${name}: clearing existing asset (state ${old.state})`); await deleteAsset(old.id) }
    console.log(`  ${name}: uploading ${size} bytes (attempt ${attempt}/${UPLOAD_TRIES})`)
    const t0 = Date.now()
    const r = await streamUp(rel, file, name, size)
    // The transfer's own verdict is not trusted (seen: an error reported for an asset that landed,
    // and a hang that never reported). GitHub's asset record is the truth.
    const now = (await assetsOf(rel.id)).find((a) => a.name === name)
    if (landed(now)) {
      const secs = Math.max(1, (Date.now() - t0) / 1000)
      console.log(`  ${name}: ok (${Math.round(secs)}s, ${(size / secs / 1048576).toFixed(1)} MB/s)`); return
    }
    console.log(`  ${name}: not landed (${r.why}; asset ${now ? now.state : 'absent'})`)
    if (attempt < UPLOAD_TRIES) await sleep(5000 * attempt)
  }
  throw new Error(`${name}: upload failed after ${UPLOAD_TRIES} attempts`)
}

async function upload(tag, files) {
  const rel = await findRelease(tag)
  if (!rel) throw new Error(`no release for ${tag} — run ensure-draft first`)
  for (const f of files) statSync(f)
  for (const f of uploadOrder(files)) await uploadOne(rel, f)
}

async function readManifests(rel, assets) {
  const out = {}
  for (const name of expectedManifests(rel.tag_name)) {
    const a = assets.find((x) => x.name === name && x.state === 'uploaded')
    if (!a) continue
    const r = await gh(['api', '-H', 'Accept: application/octet-stream', `repos/${REPO}/releases/assets/${a.id}`])
    if (r.code !== 0) throw new Error(`cannot read ${name}: ${r.err.trim()}`)
    out[name] = r.out
  }
  return out
}

async function httpStatus(url) {
  // One byte, following the redirect to the blob store exactly as the updater / a browser would.
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(60000) })
    await r.body?.cancel()
    return String(r.status)
  } catch (e) { return `error ${e.message}` }
}

async function verify(tag, { live = false } = {}) {
  const rel = await findRelease(tag)
  if (!rel) return [`no release for ${tag}`]
  const assets = await assetsOf(rel.id)
  const manifests = await readManifests(rel, assets)
  const bad = problems(tag, assets, manifests)
  if (live && !bad.length) {
    if (rel.draft) bad.push('release is still a draft')
    const names = new Set([...expectedManifests(tag), `Arbiter-${versionOf(tag)}-arm64.dmg`])
    for (const m of Object.values(manifests)) for (const f of manifestFiles(m)) names.add(f.name)
    for (const n of names) {
      const code = await httpStatus(`https://github.com/${REPO}/releases/download/${tag}/${n}`)
      if (code !== '200' && code !== '206') bad.push(`${n}: public download returned HTTP ${code}`)
    }
  }
  return bad
}

async function setDraft(tag, draft) {
  const args = ['release', 'edit', tag, '--repo', REPO, `--draft=${draft}`]
  if (!draft) args.push(isBeta(tag) ? '--prerelease' : '--latest')
  return gh(args)
}

async function publish(tag) {
  let bad = await verify(tag)
  if (bad.length) throw new Error(`NOT going live — release ${tag} is incomplete:\n  ${bad.join('\n  ')}`)
  const r = await setDraft(tag, false)
  if (r.code !== 0) throw new Error(`could not publish ${tag}: ${r.err.trim()}`)
  console.log(`release ${tag} is public — checking what clients will see ...`)
  for (let i = 0; i < 3; i++) {           // brief settle: the public URLs can lag the flip by seconds
    await sleep(5000)
    bad = await verify(tag, { live: true })
    if (!bad.length) { console.log(`release ${tag} LIVE and verified`); return }
  }
  console.error(`live check FAILED — rolling back (re-drafting ${tag}):\n  ${bad.join('\n  ')}`)
  const back = await setDraft(tag, true)
  // The flip created the tag; a bare tag is visible to beta clients, so take it back too.
  await gh(['api', '-X', 'DELETE', `repos/${REPO}/git/refs/tags/${tag}`])
  if (back.code !== 0) {
    // Last resort: pull the manifests so clients see "no update" instead of a dead link.
    const rel = await findRelease(tag)
    for (const a of await assetsOf(rel.id)) if (isManifest(a.name)) await deleteAsset(a.id)
    throw new Error(`re-draft failed (${back.err.trim()}); manifests deleted instead. Clients stay on the previous version.`)
  }
  throw new Error(`rolled back: ${tag} is a draft again; clients stay on the previous version.`)
}

async function main([cmd, tag, ...rest]) {
  if (!cmd || !tag) { console.error('usage: release-assets.mjs ensure-draft <tag> <sha> | has <tag> <asset> | upload <tag> <files...> | verify <tag> [--live] | publish <tag>'); process.exit(2) }
  if (cmd === 'ensure-draft') await ensureDraft(tag, rest[0])
  else if (cmd === 'has') {
    const rel = await findRelease(tag)
    const a = rel && (await assetsOf(rel.id)).find((x) => x.name === rest[0])
    process.exit(a && a.state === 'uploaded' ? 0 : 1)
  }
  else if (cmd === 'upload') await upload(tag, rest)
  else if (cmd === 'verify') {
    const bad = await verify(tag, { live: rest.includes('--live') })
    if (bad.length) { console.error(`release ${tag} NOT complete:\n  ${bad.join('\n  ')}`); process.exit(1) }
    console.log(`release ${tag} complete`)
  } else if (cmd === 'publish') await publish(tag)
  else { console.error(`unknown command ${cmd}`); process.exit(2) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { console.error(`FATAL: ${e.message}`); process.exit(1) })
}
