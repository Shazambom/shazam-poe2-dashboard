#!/usr/bin/env node
// Release assets, done safely — the ONE tool both halves of a release use (Windows CI and
// publish-github.sh), so the two can't drift. Fixes docs/bugs/2026-09-17-release-publish-not-atomic.md:
//
//   ensure-draft <tag>            create the release as a DRAFT (invisible to electron-updater, never
//                                 "Latest") unless one already exists for the tag
//   upload <tag> <files...>       installers first, update manifests (*.yml) LAST; per file: clear a
//                                 half-created ("starter") asset, upload with a timeout, retry, and
//                                 trust only the asset's state+size — never gh's exit code
//   verify <tag> [--live]         every file named by every channel manifest is on the release,
//                                 state "uploaded", at the manifest's size; --live also GETs each
//                                 public download URL for a 200
//   publish <tag>                 verify → flip the draft public (the single go-live moment) →
//                                 verify --live → on failure ROLL BACK (re-draft) so clients stay
//                                 on the previous version
//
// Needs `gh` (authenticated; GH_TOKEN in CI). Zero npm deps.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = 'Shazambom/shazam-poe2-dashboard'
const UPLOAD_TIMEOUT_MS = Number(process.env.RELEASE_UPLOAD_TIMEOUT_MS || 20 * 60 * 1000)
const UPLOAD_TRIES = Number(process.env.RELEASE_UPLOAD_TRIES || 3)

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

async function ensureDraft(tag) {
  const have = await findRelease(tag)
  if (have) { console.log(`release ${tag} exists (${have.draft ? 'draft' : 'PUBLISHED'}, id ${have.id})`); return have }
  const args = ['release', 'create', tag, '--repo', REPO, '--draft', '--title', tag, '--notes', '', '--target', 'main']
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

async function uploadOne(rel, file) {
  const name = basename(file), size = statSync(file).size, digest = await sha256(file)
  // Landed = GitHub holds exactly these bytes (its own sha256 of the asset; size if it reports none).
  const landed = (a) => a && a.state === 'uploaded' && a.size === size && (!a.digest || a.digest === digest)
  for (let attempt = 1; attempt <= UPLOAD_TRIES; attempt++) {
    const old = (await assetsOf(rel.id)).find((a) => a.name === name)
    if (landed(old)) { console.log(`  ${name}: already uploaded (${size} bytes)`); return }
    if (old) { console.log(`  ${name}: clearing existing asset (state ${old.state})`); await deleteAsset(old.id) }
    console.log(`  ${name}: uploading ${size} bytes (attempt ${attempt}/${UPLOAD_TRIES})`)
    const r = await gh(['release', 'upload', rel.tag_name, file, '--repo', REPO], { timeout: UPLOAD_TIMEOUT_MS })
    // gh's exit code lies in both directions (seen: exit 1 "already exists" on a landed asset,
    // and a hang that never exits). The asset record is the truth.
    const now = (await assetsOf(rel.id)).find((a) => a.name === name)
    if (landed(now)) { console.log(`  ${name}: ok`); return }
    console.log(`  ${name}: not landed (${r.timedOut ? 'timed out' : `gh exit ${r.code}: ${r.err.trim().split('\n')[0]}`}; asset ${now ? now.state : 'absent'})`)
    if (attempt < UPLOAD_TRIES) await sleep(15000 * attempt)
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
  if (back.code !== 0) {
    // Last resort: pull the manifests so clients see "no update" instead of a dead link.
    const rel = await findRelease(tag)
    for (const a of await assetsOf(rel.id)) if (isManifest(a.name)) await deleteAsset(a.id)
    throw new Error(`re-draft failed (${back.err.trim()}); manifests deleted instead. Clients stay on the previous version.`)
  }
  throw new Error(`rolled back: ${tag} is a draft again; clients stay on the previous version.`)
}

async function main([cmd, tag, ...rest]) {
  if (!cmd || !tag) { console.error('usage: release-assets.mjs ensure-draft|upload|verify|publish <tag> [files...|--live]'); process.exit(2) }
  if (cmd === 'ensure-draft') await ensureDraft(tag)
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
