# Send feedback — implementation plan

Status: BUILT (2026-09-18) — steps 1–9 landed behind `ops/run-tests.sh`; the desktop side was
driven end to end on this Mac (a report packaged in ~5–13 s, all 10 screens real, zero writes from
the snap window). Owner-steered after a four-candidate arena (synthesis note at the end).
Owner side verified on shazam the same day: keypair minted in the bot image (key id 1, public half
shipped as `desktop/src/feedback/owner-key.pub`), the opener deployed hardened, a real report → ✅ and
a tampered one → ⚠️/quarantine. **Still needed before the feature ships:** the Discord server +
invite → `DISCORD_INVITE`, the bot token → `/etc/arbiter/discord-token`, `FEEDBACK_FORUM_ID` in
shazam's `.env`, then `./ops/deploy-web.sh bot` again (docs/dev-notes.md → "Feedback reports"). Deviations
from the plan below: the offscreen-`paint` fallback (6.4a) was not built — `stayHidden` captures
worked on macOS; a screen is photographed once its fetches go quiet (not after two frames); the
desktop keeps a CommonJS twin of `dests.js` (Electron's main process cannot require the ESM file).
Supersedes the mechanics in `docs/feedback-system-design.md`; that doc keeps the problem
statement and threat framing, this one is what gets built.

## Decision summary

1. **No drop point at all.** The app packages the report to disk as one sealed file and the user
   drags it into a **Discord forum channel** (`#bug-reports`) themselves. Their Discord post is
   the message; the thread under it is the follow-up. No Worker, no bucket, no webhook, no token,
   no account anywhere that could ever bill. The only things the app ships are the owner's
   **public** key and an invite link.
2. **The desktop contract is untouched.** `shell.openExternal(invite)` opens a browser; the app
   itself still makes exactly one kind of outbound call (the updater). No CLAUDE.md change.
3. **One file per report, one drag.** `arbiter-report-<ID>.arb`. **Measured on the real app
   (2026-09-18, 1440×847 @2x, live data): all 9 screens at 1200 px wide / JPEG q60 = 0.8 MB**
   (full-resolution q60 = 2.9 MB); with ~0.2 MB of gzipped state + logs a report is ~1 MB
   against Discord's 10 MiB cap, and the fixed-width resize makes that independent of the
   user's monitor. Hard ceiling 4 MB: drop screens largest-first, `screensPartial: true`.
   `webContents.startDrag({ file })` drags it into the post.
4. **Crypto: X25519 → HKDF-SHA256 → AES-256-GCM, Node built-ins, zero dependencies.** GCM's
   tag is the integrity check; a 128-bit random `installId` inside the seal correlates reports
   from one install. `keyId` byte for owner-key rotation.
5. **Screens: a second `show:false` BrowserWindow** in `?snap=1` mode with its own minimal preload
   and a session-level GET-only filter, captured via `capturePage(undefined, { stayHidden: true })`,
   visible window captured first. Fallbacks: offscreen `paint` → visible only → none. Nothing
   flashes; a screenshot never blocks packaging.
6. **Retrieval: a small Python listener bot, `ops/feedback-bot/`, on the shazam test server**
   (a third `docker compose` service beside the web test env). It watches the forum channel,
   downloads each new post's `arbiter-report-*.arb`, opens it with the owner's private key (which
   lives only on shazam), writes the unpacked report to an inbox folder, and acks in the thread
   (✅ received / ⚠️ couldn't read). On start it catches up on posts it missed. **Parsing happens
   in a separate opener cell** — a second container with no network, no token and no key — that
   assumes every file is malicious and emits only a rebuilt, whitelisted copy (images decoded
   inside the cell and re-encoded). `discord.py` + `cryptography` (already a backend dependency)
   in the bot; `Pillow` only in the cell.
7. **Abuse is moderation.** Anyone posting hostile files is a Discord member with a name. The
   opener makes hostile bytes harmless regardless.

## Infrastructure inventory

| Component | What it is | Cost | Abuse story |
|---|---|---|---|
| Discord server: one forum channel `#bug-reports`, one invite link targeting it | The inbox and the conversation | $0, not metered | Discord's own rate limits + your mods. Nothing here can bill you. |
| Discord bot application: *View Channel*, *Read Message History*, *Send Messages in Threads*, *Add Reactions*; the **Message Content intent** (needed to see attachments; free under 100 servers) | The listener's identity | $0 | Token lives only on shazam; if it leaks, rotate in the developer portal — it can read a channel members already see and post acks, nothing more. |
| shazam (owner's LAN box, already running the web test env): two compose services — `feedback-bot` (token + key mounted read-only, dials out to Discord) and `feedback-opener` (no network, no secrets, read-only, capabilities dropped) — sharing a spool volume; `~/feedback-inbox/` | The reader, and the cell that parses | $0 (a box the owner already runs) | Fetches only attachments named `arbiter-report-*.arb` ≤ 4 MB + 65 from the one channel; no ports exposed. See threat model. |

**Nothing new is rented. The only running thing is a container on a box that already runs. Nothing can bill.**

## Wire format

```
.arb  = "ARB1"(4) | keyId(1) | ephPub(32) | nonce(12) | ciphertext | tag(16)   (65 B overhead)
key   = HKDF-SHA256(ikm = X25519(eph, ownerPub), salt = ephPub‖ownerPub, info = "arbiter-feedback-v1", 32)
AAD   = the 5 header bytes — a header edit fails the tag
plain = gzip(JSON { manifest, state, logs, screens })

manifest { v:1, id (uuid), ts, appVersion, channel, platform, arch, osRelease, electron, installId, theme, tab, sub, screensPartial }
state    { diag, status, backfill, settings (allow-listed), desktopSettings (allow-listed), bounds }
logs     { main[] ≤ 200, backend ≤ 64 KB, renderer[] ≤ 100, updater[] ≤ 40 }
screens  { current, board, strategy-arbitrage, strategy-hold, economy-inflation, economy-market,
           trading-workspace, trading-live, trading-sales, settings }   ← keys from DESTS + current only

file:   <userData>/reports/arbiter-report-<SHORTID>.arb
```

Verified on this Mac (Node 18.16, Electron 33.4.11): X25519/HKDF/GCM round-trip; raw 32-byte
pubkey imports via the SPKI prefix `302a300506032b656e032100`; `hkdfSync` returns an
**ArrayBuffer** (wrap in `Buffer.from`); `zlib.gunzipSync(buf, { maxOutputLength })` throws
`ERR_BUFFER_TOO_LARGE` on a 50 MB zip bomb. The test gate runs on Node 18: nothing may need Node 20.

## File-by-file plan (build order; each step lands green under `ops/run-tests.sh`)

### 1. Sealing — `desktop/src/feedback/seal.js` (~60) + `ops/feedback-bot/arbseal.py` (~60, incl. keygen)
- `seal.js` exports `MAGIC`, `KEY_ID`, `OWNER_PUB_B64`, `seal(plain, ownerPubB64 = OWNER_PUB_B64,
  keyId = KEY_ID) → Buffer`, and `open(sealed, privateKeyPem) → Buffer` **for tests only** (the
  real opener is Python).
- `arbseal.py`: `open_sealed(data, private_key) → bytes` with `cryptography` (`X25519`,
  `HKDF(SHA256)`, `AESGCM`) — the same construction byte-for-byte — plus `seal()` for tests and
  `python -m arbseal keygen <keyId>`: writes `feedback-key-<keyId>.pem` mode 0600 (refuses to
  overwrite) and prints the raw public key as base64 for `OWNER_PUB_B64`. Never committed, never in CI.
- **Tests:** `desktop/test/feedback-seal.test.mjs` (round-trip; two seals differ; flipping any byte
  of magic/keyId/ephPub/nonce/ciphertext/tag throws; wrong key throws; truncated input throws a
  named error; overhead exactly 65 bytes; source grep: no `BEGIN PRIVATE KEY` under `desktop/src/`,
  exactly one owner-pubkey literal) and `ops/feedback-bot/tests/test_arbseal.py` (same cases).
  **Cross-language pin:** `desktop/test/fixtures/feedback/` holds a *test* keypair and a file sealed
  by `seal.js`; `test_arbseal.py` opens it, and `feedback-seal.test.mjs` opens one sealed by
  `arbseal.py`. If either side drifts, both gates go red.

### 2. Redaction — `desktop/src/feedback/redact.js` (~60)
- `SETTINGS_KEYS` (allow-list for `/api/settings` and `desktop-settings.json`), `pickAllowed(obj,
  keys)` (unknown keys dropped, fail-closed), `SECRET_PATTERNS`, `scrubText(s)`, `redactDeep(value)`
  (walks the tree, scrubs every string, drops keys matching `/sess|cookie|token|secret|password|authorization/i`).
- Patterns: `POESESSID\s*[=:]\s*\S+`, `Bearer\s+[\w.\-]+`, `^(Set-)?Cookie:.*$`,
  `"(access|refresh|id)_token"\s*:\s*"[^"]*"`, `gAAAAA[\w=\-]+` (Fernet), `client_secret`,
  `[?&](code|state)=[^&\s]+`, ≥ 32 hex/base64 chars on a line containing `token|secret|key|sess`.
- **Test `desktop/test/feedback-redact.test.mjs`:** a poisoned object (POESESSID value, `Cookie:`
  header, `Bearer ey…`, `refresh_token`, a Fernet blob, an OAuth callback URL, a 40-hex key) →
  output contains **none** of the seeds; `pickAllowed` drops an unknown harmless key; plain text unchanged.

### 3. Log rings — `desktop/src/feedback/ring.js` (~25), `frontend/src/lib/errorRing.js` (~25), `main.js` (~20 changed)
- `makeRing(n) → { push, lines, clear }`; lines clamped to 500 chars, `HH:MM:SS` prefix.
- `main.js`: hoist `bkBuf` to module scope, `slice(-6000)` → `slice(-65536)` (crash telemetry keeps
  `.slice(-3000)`); `mainRing = makeRing(200)` fed by a `logLine()` helper at the existing
  `console.log` sites; `updRing = makeRing(40)` fed by `updLog`; export `feedbackSources()`.
- `errorRing.js`: hooks `window.onerror` + `unhandledrejection` + wraps `console.error`; 100
  entries, message + first 3 stack frames; `window.__arbiterErrors()`. One line in `main.jsx`.
- **Test `desktop/test/feedback-ring.test.mjs`:** keeps last N; clamps; never throws on non-strings.

### 4. Bundler — `desktop/src/feedback/bundle.js` (~110) + `installid.js` (~15)
- `buildBundle({ meta, sources, get, readJson, screens }) → Promise<Buffer>` — everything
  injected; no Electron, no network in tests.
- `get(path)` reads **only** `/api/diag`, `/api/status`, `/api/backfill`, `/api/settings` (4 s
  timeout each; failure → `{ error }`, never aborts). Never `/api/session` or `/api/oauth/*`.
- `redactDeep` over `{ state, logs }`; `JSON.stringify` → `gzipSync(level 9)`. Screens arrive
  already resized to 1200 px wide / JPEG q60 (~0.8 MB for all 9, measured); if the bundle exceeds
  4 MB − 65, drop screens largest-first, `screensPartial: true`. Never fail on size.
- `installId(dataDir)`: read `<dataDir>/install-id` or write `randomBytes(16).hex` at 0600.
- **Test `desktop/test/feedback-bundle.test.mjs`:** exact top-level key set; a poisoned
  `/api/settings` response and a poisoned log line are absent from the **gunzipped** output; a
  rejecting `get` still yields a bundle; a 30 MB screens input trims under the cap with
  `screensPartial`; `get` was never called with `/api/session`.

### 5. Destinations + snap mode — `frontend/src/lib/dests.js` (~25), `App.jsx` (~30 changed)
- `dests.js` exports `DESTS`: the **9 distinct screens** — `board`, the 7 existing `SUB_DESTS`
  entries, `settings` — as `{ id, section, sub, label }`. `App.jsx` derives `SUB_DESTS` from it.
- `SNAP = new URLSearchParams(location.search).get('snap') === '1'`. Under `SNAP`: skip
  `startSignalPolling`, the `notify` effect, `useLiveWiring`/`useLiveSync`, `useEe2History`, toasts
  and ⌘K hotkeys; `TradingView` renders sub-views without mounting the trade `<webview>`;
  `workspaceStore.persist` is a no-op. Register
  `window.__arbiterSnap = async ({ section, sub }) => { setTab(section); nav.openSub/openTrading(sub); await statusLoaded; await 2 rAF }`.
  Theme comes free (same origin → same localStorage → `bootTheme()`).
- **Tests:** `frontend/test/dests.test.mjs` (9 entries, unique slug ids, derived `SUB_DESTS` equals
  today's 7 — pure data, no React rendering); `desktop/test/feedback-dests-sync.test.mjs` (the
  opener's screen allow-list equals `DESTS` ids + `current` — drift here is the path-traversal hole).

### 6. The invisible sweep — `desktop/src/feedback/snap.js` (~100) + `preload-snap.js` (~10)
- `preload-snap.js` exposes only `getVersion`, `getChannel`, `hotkey.get`, `ee2.status`. No
  `trade`, `ws`, `clipboard`, `setCookie`, `feedback`: no IPC writer is reachable from the snap window.
- `sweepScreens({ uiUrl, bounds, dests, BrowserWindow, session, visibleWin, perScreenMs = 2500,
  totalMs = 20000 }) → { screens, partial }`:
  1. `screens.current = visibleWin.webContents.capturePage()` first (modals and all).
  2. `new BrowserWindow({ show: false, width, height, backgroundColor, webPreferences: { preload:
     preload-snap, sandbox: true, contextIsolation: true, webviewTag: false, backgroundThrottling: false } })`;
     **before load**, `session.webRequest.onBeforeRequest({ urls: [uiUrl + '/api/*'] }, (d, cb) =>
     cb({ cancel: d.webContentsId === snap.id && d.method !== 'GET' }))` — the snap window cannot
     write user data even if a future hook forgets the `SNAP` guard.
  3. Load `${uiUrl}/?snap=1`; per dest: `executeJavaScript('window.__arbiterSnap(…)')` →
     `capturePage(undefined, { stayHidden: true })` → `resize({ width: 1200 })` → `toJPEG(60)`.
  4. Fallbacks under `perScreenMs`: (a) re-create with `offscreen: true`, newest `paint` frame
     (verified on Electron 33.4.11/macOS; OSR paints at devicePixelRatio); (b) `current` only;
     (c) none. Any fallback → `partial: true`. `totalMs` hard deadline; window destroyed and
     filter removed in `finally`.
- **Test `desktop/test/feedback-snap.test.mjs`** with a `BrowserWindow` double: full dest list
  walked; per-screen timeout skips and sets `partial`; a throw falls through to the next strategy;
  window destroyed on every path incl. a thrown `loadURL`.

### 7. Package + hand-off — `desktop/src/feedback/index.js` (~70), preload (3 lines), renderer (~90)
- `registerFeedback({ ipcMain, BrowserWindow, session, win, uiUrl, backendUrl, userData, version,
  channel, sources, DISCORD_INVITE })` registers three handlers, all rejecting senders other than `win`:
  - `feedback:package` → throttle 60 s → `sweepScreens` → `buildBundle` → `seal` → write
    `<userData>/reports/arbiter-report-<SHORTID>.arb` (0600; the folder keeps the last 10, older
    deleted) → `{ shortId, file, screensPartial }`. Never throws into the renderer.
  - `feedback:drag` `{ shortId }` → `win.webContents.startDrag({ file, icon })` (native drag of the
    file out of the app window; `icon` = the app icon).
  - `feedback:reveal` `{ shortId }` → `shell.showItemInFolder(file)`;
    `feedback:discord` → `shell.openExternal(DISCORD_INVITE)` (invite targets the forum channel).
- `preload.js`: `feedback: { package, drag, reveal, discord }`.
- `frontend/src/components/FeedbackDialog.jsx` (reuses the `card-detail` dialog chrome,
  `role="dialog" aria-modal`, focus in/out, Esc):
  - opens → calls `package()` immediately (3–8 s spinner; nothing else moves).
  - ready → one file chip `arbiter-report-7F3K2Q` (`draggable`, `onDragStart` → `preventDefault` +
    `feedback.drag(shortId)`), one line of small text, buttons **Open Discord** · *Show file*.
  - `App.jsx`: `feedbackOpen` state; one `wsCommands` entry `{ id: 'send-feedback', label: 'Report a
    problem…', hint: 'Help' }` gated on `window.poe2desktop?.feedback`. `SettingsView.jsx`: one
    `btn small` "Report a problem…" inside the existing Diagnostics `<details>`.
  - CSS: `.fb-chip`, `.fb-note` from `:root` tokens only.
- **Tests:** `desktop/test/feedback-package.test.mjs` (stubbed sweep/bundle/seal: the file is
  written under the injected dir, 0600, pruning at 10, throttle returns `{ throttled }`, a sweep
  throw still yields a file with `screensPartial`); `feedback-contract.test.mjs`
  (structural): nothing under `desktop/src/feedback/` imports `telemetry.js`, references `installlog`,
  `192.168.`, or calls `fetch` to anything but `127.0.0.1`; `preload-snap.js` exposes none of
  `trade|ws|clipboard|setCookie|feedback|setChannel|installUpdate`; `DISCORD_INVITE` literal appears
  exactly once; `frontend/test/feedback.test.mjs` (`shortId` 6-char Crockford, no vowels).

### 8. The listener bot + the opener cell — `ops/feedback-bot/` (Python)
Two compose services on shazam sharing one spool volume; no Docker socket, no ports.

```
 Discord ──► bot   (trusted: token + private key, network)
               │   AES-GCM decrypt only — pure math, no parsing; a bad tag stops here
               │   writes  spool/in/<threadId>.gz          (plaintext, still untrusted)
               ▼
           opener (untrusted cell: network_mode none, no token, no key, read_only root,
                   non-root, cap_drop ALL, no-new-privileges, pids/mem/cpu limits;
                   a fresh child process per file under rlimits + wall-clock timeout)
               │   decompress under a ceiling → parse → validate → REBUILD from a whitelist
               │   writes  spool/out/<threadId>/{result.json, report.json, logs/*.txt, screens/*.jpg}
               ▼
           bot reads result.json (OK / REFUSE / QUARANTINE), moves the folder to INBOX, acks
```

Layout: `bot/bot.py` (~130), `bot/arbseal.py` (step 1), `opener/opener.py` (~180),
`opener/dests.py`, `requirements-bot.txt` (`discord.py`, `cryptography`),
`requirements-opener.txt` (`Pillow` only), two Dockerfiles (both non-root), the compose block
(`feedback-bot`: env `DISCORD_TOKEN_FILE`, `FORUM_CHANNEL_ID`, `KEY_DIR`, `SPOOL`, `INBOX`, secrets
mounted read-only; `feedback-opener`: `network_mode: none`, `read_only: true`, `cap_drop: [ALL]`,
`security_opt: [no-new-privileges]`, `pids_limit: 32`, `mem_limit: 768m`, `cpus: 1`, mounts only
`SPOOL`; both `restart: unless-stopped`), `tests/`.

- **`bot.py`** (`discord.py`; intents: guilds, message_content):
  - `on_thread_create(thread)` in `FORUM_CHANNEL_ID` → `handle(thread)`. `on_ready` → **catch-up**:
    walk the forum's active + archived public threads newest-first, stop at the last thread id in
    `INBOX/state.json`, `handle` each unseen one.
  - `handle(thread)`: fetch the starter message; take the first attachment whose `filename` matches
    `^arbiter-report-[0-9A-HJ-NP-Z]{6}\.arb$` and `size ≤ 4 MB + 65`; download to memory; check
    `MAGIC`/`keyId`; `arbseal.open_sealed` (bad tag → ⚠️ immediately, nothing spooled); write the
    plaintext to `SPOOL/in/<threadId>.gz` (0600, atomic rename); wait for
    `SPOOL/out/<threadId>/result.json` (≤ 60 s). `result.json` is itself schema-checked
    (`{status: OK|REFUSE|QUARANTINE, shortId: [0-9A-HJ-NP-Z]{6}, reason: str ≤ 200}`); on OK the bot
    moves **only the fixed filenames** it knows (`report.json`, `logs/{main,backend,renderer,updater}.txt`,
    `screens/NN-<known>.jpg`, `index.html`) into `INBOX/<shortId>/` — never a glob. React ✅ and reply
    `report 7F3K2Q received — thanks`; on REFUSE/QUARANTINE/timeout react ⚠️ and reply `couldn't read
    that file — was it made by Arbiter's "Report a problem"?`; the sealed original goes to
    `INBOX/quarantine/<threadId>.arb`. Record the thread id. One report per thread; extra
    attachments ignored. The bot never reads post text beyond logging the title, never follows
    links, never executes anything. Errors are logged and swallowed per thread.
- **`opener.py`** — a watcher loop over `SPOOL/in/` that, per file, spawns
  `python -m opener.cell <in> <outdir>` as a child with `resource.setrlimit` (RLIMIT_AS 512 MB,
  RLIMIT_CPU 20 s, RLIMIT_FSIZE 64 MB, RLIMIT_NPROC 0, RLIMIT_NOFILE 16) and a 30 s wall-clock
  timeout; child exit code → `result.json` (0 OK / 2 QUARANTINE / anything else = crash → REFUSE).
  Deletes the input afterwards. **Inside the cell**, hard stops in order:
  1. `zlib.decompressobj().decompress(chunk, max_length)` in a counting loop, 32 MB ceiling.
  2. `json.loads` with an `object_pairs_hook` rejecting duplicate keys, depth > 32, > 10 000 keys.
  3. **Rebuild, don't pass through.** A new document is constructed from scratch: for each field in
     the schema (`manifest.*`, `state.*`, `logs.*`, `screens.*`), read the value at that path, coerce
     to the declared type (`str` capped at N, `int` ranged, `bool`, nested dict of declared keys),
     and copy it. There is no code path that copies an undeclared key, so none can reach the
     output. Missing required field or a type that will not coerce → QUARANTINE (exit 2).
  4. Screen names must be in `dests.py` (pinned to `frontend/src/lib/dests.js` by a test). Each
     screen: base64 → bytes ≤ 2 MB → `FF D8 FF` → **decoded with Pillow inside the cell** →
     `Image.MAX_IMAGE_PIXELS` 4 MP, mode forced to RGB → **re-encoded as a fresh JPEG q75**. What
     leaves the cell is pixels we produced, never bytes they produced (the Dangerzone pattern).
     A screen that fails to decode is dropped, not fatal.
  5. Output paths derive from the schema only: `report.json` (the rebuilt document, screens
     replaced by filenames), `logs/{main,backend,renderer,updater}.txt` (plain text, each line
     ≤ 1 KB, ≤ 400 lines), `screens/<NN>-<known-name>.jpg`, `index.html` (every string through
     `html.escape`, `<meta http-equiv="Content-Security-Policy" content="default-src 'none';
     img-src 'self'">`, no scripts, no links). Every path `Path.resolve()`d under `outdir`.
  6. The cell imports only `zlib`, `json`, `html`, `pathlib`, `PIL`. No `subprocess`, `pickle`,
     `yaml`, `eval`, sockets — pinned by a source-grep test.
- **Threat assumption, stated:** anyone can read `seal.js` and produce a file the bot will
  decrypt — sealing is confidentiality, not authentication. Every guarantee comes from the cell
  having nothing to steal, no way to phone home, and an output that is rebuilt, not echoed.
- **Tests `ops/feedback-bot/tests/test_cell.py`** (each: REFUSE/QUARANTINE, nothing outside
  `outdir`): 3-byte input; 50 MB zip bomb stops at 32 MB; duplicate keys; JSON nested 5 000 deep;
  10 000 keys; unknown top-level key and unknown nested key → absent from the output of an
  otherwise-valid report (proves rebuild); screens keyed `../../.ssh/authorized_keys` and
  `/etc/passwd` → dropped, files only at schema paths; a screen not in `DESTS`; screen bytes
  `%PDF`/ELF/a 100 MP decompression-bomb JPEG (`MAX_IMAGE_PIXELS`) → dropped; a valid JPEG comes
  out re-encoded (bytes differ, decodes, same dimensions); `logs.main` with `</script><script>` →
  escaped in `index.html`; a valid report → exactly the expected file list.
  **`tests/test_opener_fuzz.py`** (`hypothesis`, ~200 examples in the gate, more with
  `--hypothesis-profile=long`): random bytes, random JSON trees, and byte-level mutations of a
  valid report → the cell always exits 0/2 or is killed, never writes outside `outdir`, finishes
  under the rlimits. **`tests/test_sandbox.py`**: a fixture cell that allocates 2 GB / loops forever
  / forks / opens a socket is killed or fails under the rlimits and reported as REFUSE.
  **`tests/test_bot.py`** (discord objects faked; spool on tmpfs): only `arbiter-report-*.arb`
  attachments are fetched, oversize skipped, a second attachment ignored, a bad GCM tag acks ⚠️
  without spooling, a malformed `result.json` is treated as REFUSE, only fixed filenames are moved,
  catch-up stops at the last seen id, an exception in one thread does not stop the next.
  **`tests/test_dests_sync.py`**: `dests.py` equals the ids in `frontend/src/lib/dests.js`.
  **`tests/test_arbseal.py`** + the cross-language fixture (step 1). Register
  `( cd ops/feedback-bot && "$PY" -m pytest tests -q )` in `ops/run-tests.sh`; `.venv-test` gains
  `discord.py`, `Pillow`, `hypothesis` (`docs/dev-notes.md` → Testing).

### 9. Docs (no code)
- `docs/dev-notes.md`: "Feedback reports" — keygen on shazam, where the PEM and bot token live
  (`/etc/arbiter/`, root-owned, mounted read-only), owner-key rotation (bump `KEY_ID`, keep the old
  PEM in `KEY_DIR`), the Discord setup (forum channel, invite targeting it, bot permissions + the
  Message Content intent), deploying the bot (`./ops/deploy-web.sh bot` → rsync `ops/feedback-bot/`
  + `docker compose up -d --build feedback-bot`), reading the inbox, the `?snap=1` mode.
- `docs/feedback-system-design.md`: status → superseded by this plan.
- **CLAUDE.md: no change.** The app makes no new outbound call; opening the invite is the OS browser.

## Threat model

| Attacker capability | What they can do | What stops it |
|---|---|---|
| Unpacks `app.asar`: gets `OWNER_PUB_B64`, `DISCORD_INVITE` | Join the Discord | Nothing to protect. There is no credential in the app. |
| Same, wants to read reports posted in the channel | Nothing | Sealed to the owner's private key (password manager). The public key only seals. |
| Posts hostile files in `#bug-reports` | Reach the opener cell on shazam | Only via the bot (name-validated, size-capped, GCM-checked) into a cell with nothing to steal and no way out: 32 MB decompression ceiling; depth/dupe/key-count limits; **output rebuilt from a whitelist, never echoed**; filenames from the schema; images decoded in the cell and re-encoded; escaped `index.html` + `default-src 'none'`; rlimits + timeout per file. And they are a named member — ban them. |
| Floods the channel | Noise | Discord slow-mode + moderation. Cannot bill anyone. |
| Social-engineers via the post text | Phishing link | It's a Discord post — same as any other; the tooling never reads or follows post text. |
| Impersonates another install | Forge `installId` | 128 random bits inside the seal; never readable. A new id is "unknown reporter", never proof. |
| Owner's private key stolen | Reads reports sealed to that `keyId` | Rotate: new PEM, bump `KEY_ID`, ship. Old reports readable with the old PEM. |
| Owner's bot token stolen | Read the channel (already visible to members), post acks | Rotate in the developer portal. Minimal perms. |
| Full RCE inside the opener cell (a `zlib`/`json`/Pillow zero-day) | Write junk into `spool/out` for that one report | The cell has no network, no token, no key, read-only root, no capabilities; the bot copies only fixed filenames and schema-checks `result.json`. Blast radius: one report. |
| Compromise of the bot container | Read the inbox; the private key file | Non-root, read-only key mount, no ports; the bot parses nothing but Discord's own API objects (the library) and `result.json` (schema-checked). The box is on the LAN. Rotate `KEY_ID` if ever in doubt. |
| The app leaks a user secret | POESESSID/OAuth in a report | Allow-list first, `redactDeep` second, credential-free endpoints only, `/api/session` never requested; pinned by three tests. Account name *is* in screenshots and status — hence the disclosure line. |

## UI (§0-sized)

- Entry points: ⌘K → **Report a problem…** (hint *Help*); Settings → Diagnostics → one **Report a
  problem…** button. Nothing on the Board, no badge, no nag.
- Dialog (existing `card-detail` chrome): title **Report a problem**. While packaging: the spinner
  (3–8 s; nothing else moves, nothing flashes). Then:
  > `⠿ arbiter-report-7F3K2Q`  ← draggable chip
  >
  > <small>Drag this into **#bug-reports** and describe what happened. It holds Arbiter's diagnostics and pictures of its screens, encrypted so only the developer can read it.</small>
  >
  > `Open Discord`   `Show file`
- Never shown: screen count, `partial`, sizes, key id, which endpoints answered.

## Verification

| Step | Proof |
|---|---|
| 1–4, 7–8 | `bash ops/run-tests.sh` — every named suite; a red test blocks both deploy scripts. The secret-strip assertion and the hostile-report suite must never be skipped. |
| 5–6 sweep | Dev launch with `--remote-debugging-port=9222`; open the dialog via ⌘K **once** (the data dir is the owner's — never a synthetic POST); open the produced file with `opener.py`: every dest present, each JPEG > 15 KB, not a flat colour (4-bucket histogram), on Vault and on Divinity; `scripts/console.mjs` on `?snap=1` shows no renderer exception; the backend access log shows only GETs from the snap window; over the CDP screencast the visible window shows zero tab changes and zero focus loss. |
| 7 dialog | CDP: dialog mounts and traps focus, Esc closes, chip is `draggable`, `Show file` reveals the data file in Finder; `shot.mjs` on both themes; `npm run lint:style`. |
| End-to-end | Deploy the bot to shazam → `npm run dist:mac` → `open release/mac-arm64/Arbiter.app` → Report a problem → drag the chip into the forum channel → the bot reacts ✅ within seconds → `~/feedback-inbox/<shortId>/index.html` shows 10 screens + logs. Then post a deliberately hostile `.arb` (from the test fixtures) → ⚠️ ack, `quarantine/` holds the raw bytes, nothing else written. Stop the bot, post a report, start it → catch-up picks it up. |
| Contract | `feedback-contract.test.mjs` + the existing `telemetry.test.mjs` guard stay green; CLAUDE.md unchanged. |
| Ship | Beta pre-release first (explicit "deploy dev"); the first real Windows beta report tells us whether `stayHidden` works there (`screensPartial` in the manifest) and whether the native drag lands in Discord on Windows; stable only after the owner validates and says "ship". |

## Arena synthesis note

Four candidates (Fable ×2, Opus ×2) plus an Opus cross-judge, all reading the code and researching
drop points. **Convergence:** X25519→HKDF→AES-GCM with Node built-ins; the opener as the only parser
and the real security boundary; a hidden `?snap=1` second window; the same one-dialog UI.
**Divergence:** the sink (R2 / KV / Worker→Discord) and how much crypto ceremony to keep.

**Owner steer after the arena replaced the sink entirely:** every candidate still had *something*
running or extractable (a Worker, a token, a free tier that "can do crazy things"). The owner's
alternative — package to disk, user drags into a Discord forum post, a small Python listener bot
on the owner's existing test server unpacks it and acks — rents nothing, puts no credential in the
app, has no bill path, decrypts where the private key already lives, and leaves the desktop
contract untouched. The screenshot-size experiment (0.8 MB for 9 screens) collapsed a two-file
split back to one file. Kept from the arena: C4's crypto cuts and verified gotchas; C1's
mechanical snap-window isolation (own preload, GET-only session filter, `webviewTag:false`, visible
window first); C3's `DESTS` sync test and `__proto__`/depth fixtures; C2's fail-closed settings
allow-list and the Node-18 constraint. **Cut:** the Worker, `send.js`, tokens, rate limiting, the
Downloads fallback, the in-app textarea (the Discord post is the message), and the CLAUDE.md change.
**Judge's factual corrections applied:** 9 distinct screens, not 12; WAF rate-limit rules are
zone-scoped (moot now); R2 needs the checkout flow (confirmed from Cloudflare's get-started page).
