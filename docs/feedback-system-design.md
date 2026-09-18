# In-app feedback reports — design

Status: PROPOSAL (2026-09-18). Nothing built yet. **Mechanics superseded by
[`feedback-implementation-plan.md`](feedback-implementation-plan.md)** (arena-synthesized): the sink
is a Worker → Discord attachment rather than R2 (R2 needs the checkout/card flow), the Ed25519
install key / manifest hash / HMAC gate are cut in favour of GCM + a sealed `installId` + a static
rotatable token, and the WAF rate-limit rule below is replaced by the Workers Rate Limiting binding
(WAF rules are zone-scoped and do not apply to `workers.dev`). §1–§3 and §8 remain the problem
statement and threat framing.

The user types what went wrong; the app silently packs a snapshot of itself (state JSON,
logs, a screenshot of every screen), encrypts it so only the owner can read it, signs it,
and drops it in a serverless inbox. No box to run. Zero cost at our volume.

## 0. The shape in one picture

```
 user ─► "Send feedback" dialog ─► message
                                     │
 main.js  collect ──► state.json (diag/status/settings, secrets stripped)
          collect ──► logs        (main ring, backend tail, renderer errors)
          sweep   ──► screens/*.jpg   (offscreen window, 12 screens, invisible to user)
                                     │
          bundle  = gzip(JSON{manifest, message, state, logs, screens})
          sign    = Ed25519(install key)  over sha256(bundle)         ─┐ inside
          seal    = X25519(ephemeral → owner PUBLIC key) + AES-256-GCM ─┘ the file
                                     │
          PUT https://arbiter-inbox.<you>.workers.dev/r/<id>   (+ cheap HMAC gate header)
                                     │
 Cloudflare Worker (≈40 lines) ──► R2 bucket  reports/2026/09/<id>.arb
                                     │
 you:  ops/feedback-pull.mjs list | get <id> | decrypt  ──► folder with report.json, logs/, screens/
```

## 1. Receiver: where do reports go without a server?

Requirements: free (or pennies), nothing to patch or keep alive, accepts a 2–8 MB binary
blob from an unauthenticated desktop app, lets us cap size and shed spam, easy to pull from.

| Option | Cost | Server to run | Blob size | Can we validate/cap? | Verdict |
|---|---|---|---|---|---|
| **Cloudflare Worker + R2** | Free: 100k req/day, 10 GB storage, 1M writes/mo, no egress | none (deploy once with `wrangler`) | 100 MB body cap | yes — the Worker checks the gate header, size, shape; 1 free WAF rate-limit rule | **pick** |
| Backblaze B2, bundled write-only app key | Free 10 GB | none, zero code | fine | no — anyone with the (extractable) key can fill the bucket; key must be made via API (`listBuckets`+`writeFiles` only) | runner-up if we want literally zero code |
| Discord webhook to a private channel, straight from the app | free | none, zero code | 10 MB/file (free guild) | no; the webhook URL *is* the secret and ships in the app → anyone can post into the channel; rotating it needs an app release; reports are chat attachments, not a bucket you can script over. Upside: a phone notification for free | viable v1; better as the **notifier** (below) |
| GitHub Issue via bundled fine-grained PAT | free | none | 64 KB body, no binary | no; token extractable → spam issues on a public repo, reports public | no |
| Sentry User Feedback | free 5k events/mo | none | attachments quota small | they parse the payload → can't be end-to-end encrypted; big SDK in the renderer | no (conflicts with "only I can decrypt") |
| Formspree / EmailJS | free tier ~50/mo | none | attachment caps | no | no |
| Reuse `POST /api/installlog` on shazam | free | **yes — the box you don't want to run**, LAN IP | 20 KB text | — | no |

**Cloudflare Worker + R2.** It is "serverless" in the sense you asked for: one ~40-line
file deployed once, no VM, no patching, no uptime to babysit; Cloudflare runs it. Everything
we need sits in the free tier and stays there: at ~3 MB a report the 10 GB allowance is
~3,000 reports, and an R2 lifecycle rule deletes objects after 90 days so it never fills.

The Worker (`ops/feedback-worker/worker.js`):

```js
export default {
  async fetch(req, env) {
    if (req.method !== 'PUT') return new Response(null, { status: 405 })
    const id = new URL(req.url).pathname.slice(3)               // /r/<uuid>
    const len = Number(req.headers.get('content-length') || 0)
    const ts  = req.headers.get('x-arbiter-ts')
    const mac = req.headers.get('x-arbiter-gate')
    if (!/^[0-9a-f-]{36}$/.test(id) || len < 64 || len > 8 << 20) return new Response(null, { status: 413 })
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 600)        return new Response(null, { status: 403 })
    if (!(await gateOk(env.GATE_SECRETS, `${id}|${len}|${ts}`, mac))) return new Response(null, { status: 403 })
    const key = `reports/${ts.slice(0, 4)}/${ts.slice(5, 7)}/${id}.arb`   // ts is ISO
    await env.INBOX.put(key, req.body, { httpMetadata: { contentType: 'application/octet-stream' } })
    return new Response(null, { status: 201 })
  }
}
```

**Notification: the Worker pings Discord.** After the R2 put, the Worker POSTs an embed to a
private channel's webhook — report id, version, platform, size, and whether the install key
is new — with `feedback-pull get <id>` as the copyable line. The webhook URL is a Worker
secret (`DISCORD_HOOK`), never in the app, so it can't be extracted or spammed directly; the
user's message stays inside the sealed file, never in the embed. Ten lines, still $0, and a
phone push the moment a report lands.

`GATE_SECRETS` is a Worker secret holding a comma-separated list, so an old gate secret can
be retired one release after a new one ships. The gate MAC covers only `id|len|ts` — never the
body — so the Worker stays under its 10 ms CPU budget on the free plan; body integrity lives
*inside* the sealed bundle (§3). `wrangler.toml` binds the `INBOX` R2 bucket; deploy is
`wrangler deploy` + `wrangler secret put GATE_SECRETS`. A free-plan WAF rate-limit rule
(10 PUTs / minute / IP) on the Worker route is the spam ceiling.

## 2. What goes in a report

One JSON document, gzipped, then sealed (§3). Target ≤ 4 MB.

```
manifest   id (UUID v7 — sortable by time), ts, appVersion, channel (stable|beta),
           platform, arch, osRelease, electron, installPub (Ed25519 pubkey, base64),
           sha256 (of everything below, canonical JSON), sig (Ed25519 over sha256)
message    text, screen the user was on (tab/sub), theme
state      /api/diag, /api/status, /api/backfill, /api/settings, desktop-settings.json,
           window bounds, statusStore + workspaceStore snapshots — SECRETS STRIPPED (below)
logs       main[]        200-line ring buffer in main.js (new — today nothing is kept)
           backend       last 64 KB of stdout/stderr (bkBuf grows from 6 KB to 64 KB)
           renderer[]    ring of console.error / unhandledrejection / failed fetches
                         (new — installed in main.jsx; 200 entries, message+stack only)
           updater[]     last updater status lines
screens    { "board": <jpeg b64>, "strategy/arbitrage": …, … }  12 screens, JPEG q70
```

**Secret stripping is a test, not a habit.** The bundler runs an allow-list over settings
(the settings blob carries no secrets today — POESESSID and OAuth tokens live Fernet-encrypted
in `kv` and never leave the backend — but the allow-list is what keeps that true), and a
unit test feeds a fixture containing a fake `POESESSID=…`, `Bearer …`, and a cookie header
through the whole bundler and asserts none of it survives. Logs are scrubbed with the same
regex set. The PoE account name *is* visible in screenshots and status; that is fine (the
report is sealed) but it is why the dialog discloses screenshots (§5).

### Screens: every view, invisible to the user

Electron's `webContents.capturePage()` captures the app's own window — no OS screen-recording
permission, no prompt, nothing the user can notice. The problem is *every* view: driving the
visible window through 12 screens would flash tabs for a couple of seconds. So the sweep
does not touch the visible window at all:

1. `main.js` opens a second `BrowserWindow({ show: false, webPreferences: { offscreen: true,
   preload } })` at the visible window's size, loading the same local UI URL with
   `?snap=1&theme=<id>`. Offscreen rendering paints to a bitmap, so a hidden window still
   renders and `capturePage()` works.
2. In snap mode the renderer (a) does not start anything with side effects — no `connectSession`,
   no EE2/trade engine, no notifications — and (b) exposes `window.__arbiterSnap(dest)` which
   sets the tab (`setTab`) and sub (`nav.openSub`), waits until the status store is loaded and
   two frames have painted, and resolves.
3. Main walks `SUB_DESTS` (App.jsx — the ⌘K destination list is the canonical "every screen"),
   calls `capturePage()` after each, `toJPEG(70)`, and closes the window. ~3–5 s total, all
   local GETs against the bundled backend.

Same theme, same data, same window size, so the screenshots are what the user is looking at.
Fallback if offscreen rendering ever misbehaves on a machine: capture the visible window as-is
(one screen) and note `screens_partial: true` in the manifest. Never fail the send over a
screenshot.

## 3. Crypto: only you can read it; you can tell who sent it

Three properties, three mechanisms, all Node `crypto` built-ins — no new dependency, and the
decryptor is a 40-line script.

**Confidentiality — a public key in the app, not a secret.** You asked for "a secret bundled
in the app for encrypting". Anything in the app is extractable (`app.asar` is a zip), so a
bundled *symmetric* secret would let anyone who unpacks the app read every report. Public-key
sealing costs nothing more and closes that: the app ships your X25519 **public** key; the
private key lives in your password manager and `ops/feedback-pull.mjs` reads it from
`~/.config/arbiter/feedback.key` (never the repo). Per report: fresh ephemeral X25519 keypair
→ ECDH with your pubkey → HKDF-SHA256 → AES-256-GCM. File layout:

```
"ARB1" | keyId(1) | ephemeralPub(32) | nonce(12) | ciphertext | gcmTag(16)
```

`keyId` lets you rotate the owner key: ship a release with key 2, keep decrypting key-1
reports with the old private key.

**Authenticity — an install key, honestly.** "Signed by the client with a bundled secret"
can't mean much, for the same extractability reason: a bundled signing key proves only "the
sender read the asar". What *is* provable: on first run each install generates an Ed25519
keypair next to the backend's `secret.key` (same 0600 treatment). Every report is signed with
it and carries the public half, so you can say "these three reports are the same install",
spot a tampered bundle, and nobody can forge a report *as* that install without its key. The
bundled HMAC gate secret (§1) is kept, but for what it really is — a spam filter the Worker
checks, rotated by release — not a security boundary.

**Integrity — hash inside the seal.** `manifest.sha256` is over the canonical JSON of
everything else; the signature is over that hash; both are inside the encrypted body, so the
Worker never sees plaintext and the decryptor verifies hash + signature after opening.

## 4. Transport in the app — and the contract

`desktop/src/feedback/` (main process, Node `fetch`):

- `crypto.js` — `seal(buf, ownerPub, keyId)`, `sign(buf, installKey)`, `installKey()` (create-on-first-use).
- `bundle.js` — collects state (read-only loopback GETs), rings, strips secrets, gzips.
- `snap.js` — the offscreen sweep.
- `send.js` — `PUT` with `x-arbiter-ts` / `x-arbiter-gate`; 20 s timeout; on any failure
  writes the sealed file to `~/Downloads/arbiter-report-<shortid>.arb` (the existing
  `exportFile` pattern) so the user can hand it over another way.
- preload: `feedback.send(message) → { id, sent: true } | { id, savedTo }`.

**This is a contract change and needs its line in CLAUDE.md.** Today the desktop contract
permits exactly two outbound calls: the updater, and beta-only telemetry through
`diagTelemetryOn()`. A feedback upload is a third — *user-initiated, one PUT, stable builds
included* — and it must NOT go through the telemetry gate (that gate is deliberately
beta-only) nor the telemetry sender (text/plain, 4 KB, LAN IP). Proposed contract text:

> Feedback reports (owner directive 2026-09-18): a **user-initiated** "Send feedback" sends
> ONE sealed bundle to the feedback inbox Worker (`FEEDBACK_URL` in `desktop/src/feedback/send.js`),
> on every channel. Nothing is sent without the user pressing Send. It is the only sender of
> its kind; it never carries POESESSID/OAuth material (enforced by `feedback-strip.test.mjs`).

## 5. The UI (§0-sized)

- ⌘K → "Send feedback…", and a `Send feedback` button at the top of Settings. Nothing else on
  screen; no nag, no badge.
- A small modal (reuses the `CardDetail` dialog chrome): one textarea ("What happened?"),
  one line of small text — *Sends your message with Arbiter's diagnostics and screenshots of
  its screens. Encrypted; only the developer can read it.* — and `Send`.
- Press Send → button shows the spinner (2–5 s) → toast `Sent · report 7F3K2Q` (a short id
  the user can quote back to you) or `Couldn't reach the inbox — saved to Downloads`.

On disclosure: keep that one line. The sweep is invisible (offscreen window, nothing
flashes), which is what "don't scare the user" needs; *hiding* that screenshots are included
is the thing that would scare people if they ever found out, and the screenshots carry their
account name. One plain sentence costs nothing and keeps the report defensible.

## 6. Reading reports

`ops/feedback-pull.mjs` (Node, uses the R2 S3 API with an owner-only token kept locally, or
shells to `wrangler r2 object`):

```
feedback-pull list [--since 7d]           id, ts, size, appVersion (from object metadata)
feedback-pull get <id>                    downloads reports/…/<id>.arb
feedback-pull open <file> [--out dir]     decrypt + verify → dir/report.json, logs/*.txt, screens/*.jpg
```

`open` refuses (loudly) on hash/signature mismatch. A `--web` flag can drop the folder into a
throwaway HTML index so the 12 screenshots are one scroll.

## 7. Build order (each step drives the app before it lands)

1. `crypto.js` + tests: seal/open round-trip, tamper → GCM fail, wrong keyId → clear error,
   install-key creation + signature verify.
2. `bundle.js` + rings (main log ring, bigger `bkBuf`, renderer error ring) + the
   secret-strip test with poisoned fixtures.
3. `snap.js` — offscreen sweep; CDP-driven check that 12 JPEGs come back, each > 20 KB and
   not a flat colour, on Vault and on Divinity.
4. `send.js` + preload + the dialog + ⌘K entry; failure path writes to Downloads.
5. `ops/feedback-worker/` (worker + wrangler.toml), deploy, `ops/feedback-pull.mjs`;
   end-to-end: send from the packaged Mac build, pull, open, read the screenshots.
6. Docs: CLAUDE.md contract line, `docs/dev-notes.md` (keys: where the owner private key and
   gate secret live, how to rotate), release runbook (gate-secret rotation step).

Roughly 600 lines all in, no new dependencies in the app. Ship as a beta first; the first
real report is the acceptance test.

## 8. Threat model: malicious reports

The uncomfortable fact first: **no desktop app can prove "this came from the real app."**
Everything the app ships — gate secret, signing key, the encryption code — is in `app.asar`,
which is a zip anyone can unpack; there is no App-Attest / Play-Integrity equivalent for an
unsigned Electron app on Windows or macOS. A determined attacker can always produce a
bundle that is byte-for-byte what the app would produce, with their own content inside.
Any design that *relies* on "only the app can send" is a design that fails quietly.

So the guard is not to trust the sender — it is to make a hostile report **harmless**, and
to bound how much of them can arrive. The report is untrusted input at every hop:

**1. The Worker never parses a report.** It checks four headers and the byte length, then
copies `req.body` into R2. There is no JSON, no image decoder, no code path an attacker's
bytes can reach. The worst a hostile PUT can do is occupy ≤ 8 MB of a 10 GB bucket, and the
edge rate-limit (10/min/IP) plus the 90-day lifecycle bound that.

**2. The decryptor is the only parser, and it is written as if every report is hostile.**
`feedback-pull open` is where a malicious payload would actually bite (it parses JSON,
decodes images, writes files), so it is built like a firewall, not a convenience script:
- AES-GCM authentication first: any byte flipped anywhere → refuse before parsing.
- Hard caps before parsing: sealed file ≤ 8 MB, gunzip output ≤ 32 MB (streamed with a
  ceiling — a zip bomb stops at the ceiling), `JSON.parse` only under those caps.
- **Strict schema, allow-list only**: every top-level key, every `state`/`logs` key, every
  screen name must be one of the names the app writes (screens are exactly the `SUB_DESTS`
  list). Unknown key → the report is quarantined, not opened. String fields have length
  caps; numbers have ranges; no field is ever `eval`'d, required, spawned or opened.
- **Filenames come from the schema, never the payload.** Output paths are
  `<out>/screens/<index>-<known-name>.jpg`, `<out>/logs/main.txt`, … — a report cannot name
  a file, so path traversal (`../../.ssh/authorized_keys`) has no input to travel through.
- Screens are checked for JPEG magic bytes and a sane size, then written as bytes; the tool
  never decodes them itself. Viewing happens in the browser or Preview — the best-fuzzed
  image decoders you own — and the `--web` index HTML escapes every string it renders
  (`textContent`, never `innerHTML`), so the message text is text even if it's `<script>`.
- No network access in `open`; `list`/`get` talk only to your R2 bucket.
- Belt and braces for the paranoid case: `open` supports `--sandbox`, which runs itself
  inside a throwaway container / `sandbox-exec` profile with only the output dir writable.

**3. Provenance is scored, not assumed.** The install key (§3) gives every report a stable
identity. `list` marks reports whose install key has never been seen before, whose
`appVersion` isn't a version we shipped, or whose gate secret is one we've retired. A
first-time-seen install with an odd version is still *readable* — the parser is safe — but
you know to read it with the sandbox on.

**4. The message is social-engineering surface.** The text field is the attacker's only
channel to a human. The web index renders it as inert text, truncated at 4 KB, and never as
a link. Nothing in a report is ever executed, followed or installed by any of our tooling.

What this buys you: an attacker can waste a little disk and a little of your time. They
cannot read anyone's reports (sealed to your public key), cannot forge another install's
identity, cannot execute anything on your machine, cannot write outside the output folder,
and cannot make a report *look* trustworthy to the tooling. That is the strongest guarantee
available for an anonymous desktop sender; "scanning" the ciphertext at the edge is not
possible by construction (only you can open it), which is exactly why the opener carries the
scan.

## 9. Open decisions (owner)

- Retention: 90-day R2 lifecycle delete — fine?
- Screenshot sweep: all 12 screens (offscreen window, ~4 s) vs. just the screen they were on
  (instant). Design assumes all 12.
- Rate ceiling: 10 sends / minute / IP at the edge; also a client-side 1 send / 30 s.
