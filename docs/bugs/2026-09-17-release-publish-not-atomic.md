# BUG — a release goes live before its files do (publish is not atomic)

**Status:** FIX BUILT 2026-09-17, unproven until the next real release (see the last section) · **Severity:** high (can strand production clients on a broken update) ·
**Found:** 2026-09-17 during 0.2.60-beta.1 and stable 0.2.60 · **Owner directive:** "This kind of
shaky release is bad, it could produce clients in a bad state" — dig in and fix the process.

## What happened (times UTC, 2026-09-17)

Earlier the same day five releases (0.2.58-beta.1 … 0.2.59) uploaded in 1–2 minutes each through the
same steps. Then GitHub's release-asset uploads (`uploads.github.com`) started stalling/failing on the
large files (~178 MB). githubstatus.com reported "All Systems Operational" throughout.

**0.2.60-beta.1**
- 16:58 tag pushed → Windows CI run 35249820587. Build, sidecar crash-gate, packaging: all green.
- 17:02 step "Upload installer to a Release" (`softprops/action-gh-release@v2`) uploaded `beta.yml` +
  the `.blockmap`, then **hung on `Arbiter-Setup-0.2.60-beta.1.exe` for 28 min**. No step timeout.
- 17:30 cancelled + re-ran → **failed: `##[error]Error saving asset`**. Cause: the hung attempt left
  the `.exe` on the release in state **`starter`** (a half-created asset); a second upload under the
  same name is rejected. `overwrite_files: true` does not clear a `starter` asset.
- 17:37 deleted the `starter` asset via the API, re-ran the failed job → upload took ~15 min, succeeded 17:53.
- **Exposure: ~17:02 → 17:53 (≈50 min) `beta.yml` was live with no installer behind it.** Any beta
  client checking in that window was told "update available" and then failed the download.

**stable 0.2.60**
- Windows CI uploaded cleanly this time. `publish-github.sh` then ran
  `gh release upload … --clobber` for the five Mac files and died:
  `HTTP 500: Error saving asset (…/assets?name=Arbiter-0.2.60-arm64-mac.zip)`; script exit 1.
- Result on the release: `latest-mac.yml` **uploaded**, `Arbiter-0.2.60-arm64-mac.zip` and
  `Arbiter-0.2.60-arm64.dmg` both **`starter`**, and the release was already GitHub's **"Latest"**
  (the Windows CI created it as a normal, published release).
- **Exposure: ~18:28 → 18:41 (≈13 min) PRODUCTION Mac clients were pointed at a zip that did not exist.**
- 18:41 mitigation: deleted `latest-mac.yml` from the release (Mac clients then see no manifest and
  stay on 0.2.59 — harmless). Deleted both `starter` assets and re-uploaded the zip from this Mac; that
  upload ALSO stalled > 10 min (so the slowness is not specific to the Windows runner).
- **Measured during that re-upload:** the `gh release upload` process was sending **~52 KB/s** to
  `uploads.github.com` (80 MB in 20 min) while the same Mac pushed **~27 MB/s** to Cloudflare in the
  same minute. So this is GitHub's asset-upload path being throttled/degraded for this repo or
  region — not our uplink, and not the Windows runner. githubstatus.com never reported it.
  *(See "State left behind" at the bottom for where this ended.)*

## Why this is a process bug, not just a bad GitHub day

GitHub being slow was the trigger. The damage came from how we publish:

1. **The manifest goes up before / independently of the installer it points to.** `latest*.yml` /
   `beta*.yml` is what electron-updater reads; the moment it exists, clients act on it. Both the CI
   action (one `files:` glob, uploaded concurrently) and `publish-github.sh` (`FILES=(… yml)` in one
   `gh release upload`) upload the manifest alongside the big files, so a small yml lands in seconds
   while the 178 MB file is still in flight — or never lands.
2. **The release is public (and "Latest") while half-built.** Windows CI creates a published release;
   the Mac files arrive later from a different machine. For stable, GitHub flips "Latest" to it as soon
   as it exists — long before it is complete. There is no single moment where "everything is there,
   now go live".
3. **No timeout, no retry, no cleanup.** The CI upload step has no `timeout-minutes`; a hung upload
   burns 28 min and leaves a `starter` asset that makes the *next* attempt fail until someone deletes
   it by hand through the API.
4. **No verification, no rollback.** Nothing checks, after publishing, that every manifest's `path:`
   resolves (HTTP 200) and every asset is `state == "uploaded"` with the expected size. When the Mac
   upload 500'd, the script just exited 1 and left production pointing at nothing.
5. **We can't see client-side damage.** `autoUpdater.on('error')` exists in `desktop/src/main.js`
   (~line 416) but a stable build sends no telemetry (by contract), and on beta no `p=update` error
   line showed up for the 50-minute window — either nobody checked then, or the failure is not
   reported. We do not currently KNOW whether any client hit the broken window.

## What a client actually does in the bad window (needs confirming)

Not verified — the next agent should reproduce it: point a packaged build at a release whose yml names
a missing file. Expectation from electron-updater's GitHub provider: `update-available` fires, the
download 404s, `error` fires, the app keeps running the old version and retries on the next check —
i.e. annoying, not bricking. **Confirm that**, and confirm the Windows NSIS path never leaves a partial
installer that a later `quitAndInstall` could run. Until confirmed, treat the window as unsafe.

## Proposed fix (for the next agent — none of this is implemented)

Make "live" a single atomic flip at the END, and make uploads self-healing:

1. **Draft-first releases.** CI creates the release as a **draft** (`draft: true` in
   `softprops/action-gh-release`), uploads the Windows files; `publish-github.sh` uploads the Mac
   files into the same draft; then a final step verifies and **publishes** (`gh release edit <tag>
   --draft=false`, plus `--latest` for stable / `--prerelease` for beta). Drafts are invisible to
   electron-updater and never become "Latest", so nothing is exposed until that one flip.
   ⚠️ Check: a draft has no tag-based download URLs and the GitHub provider can't see it — good — but
   the Mac-side script currently finds the release by tag; with a draft, look it up by id / `gh release view`.
2. **Manifests last, always.** Even inside a draft: upload installers + blockmaps, verify them, THEN
   upload the yml files.
3. **Verify before the flip** (one function, used by both channels): every expected asset present with
   `state == "uploaded"` and the size on disk; each manifest's `path:` names an asset on the release;
   after the flip, `curl -I` each manifest → installer returns 200 (the runbook step 7 check, automated).
4. **Self-healing uploads:** `timeout-minutes` on the CI upload step (≈10); before any (re)upload,
   delete assets in `starter` state; retry N times with backoff; fail loudly with the asset list.
5. **Automatic rollback:** if verification fails after a flip, delete the manifests (what was done by
   hand at 18:41) or re-draft the release, so clients fall back to the previous version's manifest.
6. **Visibility:** on the beta channel, log `p=update` for `error` with the failing URL/status so a
   broken window is visible in `GET /api/installlog`. (Stable stays telemetry-free — contract.)
7. **Shrink the files** — the real lever on upload time and on how long any window lasts:
   `strategy-ecosystem-plan.md` Phase 7b (PyInstaller `--onedir`, don't re-ship the ~40 MB snapshot
   every release). Still not started.
8. **Runbook:** add "if an upload hangs" to `docs/release-runbook.md`: cancel → delete `starter`
   assets (`gh api repos/<repo>/releases/<id>/assets` → `DELETE …/assets/<id>`) → re-run failed job;
   and "if a manifest is live without its file: delete the manifest first, fix second".

## Evidence / how to look

- CI run: `gh run view 35249820587 --log-failed` (the `Error saving asset` attempt) — same run id holds
  all three attempts.
- Asset states: `gh api repos/Shazambom/shazam-poe2-dashboard/releases/<id>/assets -q '.[]|"\(.name) \(.state) \(.size)"'`
  — `starter` = half-created.
- Local logs from the session (not committed): the publish script output showed
  `HTTP 500: Error saving asset (https://uploads.github.com/…name=Arbiter-0.2.60-arm64-mac.zip)`.
- Beta telemetry around the window: `GET http://192.168.1.250:8080/api/installlog` — the Windows beta
  client updated cleanly at 18:02, AFTER the installer landed; nothing is logged for 17:02–17:53.

## State left behind

As of 18:55 UTC 2026-09-17 (when this report was committed):
- **Beta 0.2.60-beta.1:** complete and verified (9 assets `uploaded`, both manifests resolve 200).
- **Stable 0.2.60:** GitHub "Latest". **Windows complete and correct** (`latest.yml` → `.exe` 200).
  **Mac NOT live:** `latest-mac.yml` deliberately removed; the zip re-upload was still trickling at
  ~52 KB/s. Mac stable users therefore remain on 0.2.59 (safe). To finish: wait for / redo the upload
  of `desktop/release/Arbiter-0.2.60-arm64-mac.zip` and `Arbiter-0.2.60-arm64.dmg`, confirm both are
  `state == "uploaded"` with sizes 177647335 / 182102371, and ONLY THEN upload
  `desktop/release/latest-mac.yml`, then check `latest-mac.yml` → zip returns 200.
  If a later commit to this file says "Mac side completed", that was done.

**Update 19:13 UTC — Mac side completed.** The zip re-upload finished after ~40 min (started 18:31).
Verified before going live: asset `state == "uploaded"`, size 177647335 == local file, download
returns 200 with that content-length, local sha512 == the manifest's. Only then was `latest-mac.yml`
re-uploaded; `latest.yml → .exe` and `latest-mac.yml → .zip` both return 200. The `.dmg` (fresh
installs only; the updater uses the zip) was started afterwards as a separate upload — check it is
`uploaded` (182102371 bytes) and re-run `gh release upload desktop-v0.2.60
desktop/release/Arbiter-0.2.60-arm64.dmg --clobber` if it is missing or `starter`.
Total Mac production exposure to a manifest with no file: ~13 min (18:28–18:41). Mac production was
held on 0.2.59 for ~32 min after that (18:41–19:13) — safe, just delayed.


**Correction 19:40 UTC — three claims above are wrong (found re-reading the report against the code).**
- **The Mac update path uses the DMG, not the zip.** `desktop/src/main.js` sets `autoDownload = !IS_MAC`
  and the Mac flow opens `macDmgUrl(v)` (`…/Arbiter-<v>-arm64.dmg`) in the browser. So "the `.dmg` is
  fresh installs only" is false, and putting `latest-mac.yml` back at 19:13 re-opened the hole: Mac
  clients were offered 0.2.60 with a DMG link that 404'd until the DMG landed (~19:13 → ≤19:31).
  Real Mac exposure ≈ 13 min + up to ~18 min. The verify-before-flip check must cover **every file
  listed in the manifest plus the DMG**, not just `path:`.
- **Proposed fix #6 already exists.** The `error` handler calls `updLog('ERROR …')`, so beta update
  errors are already in `/api/installlog`. Silence in the 17:02–17:53 window means no beta client
  checked then.
- **"What a client does" is partly answerable from code:** the same handler classifies any message
  matching `404` as benign and shows "up to date". A client in the bad window sees nothing and retries
  in 30 min — not bricked. Still unverified: whether Windows can keep a partial download (sha512 check
  should reject it). Severity is therefore closer to **medium** than high.
- DMG final state: `uploaded`, 182102371 bytes, downloaded copy's sha512 == local file. The `gh` command
  itself exited 1 with `422 ReleaseAsset.name already exists` even though the asset landed — `gh`'s exit
  code is not a reliable success signal here; only the asset-state check is.

## Fix built (2026-09-17) — what exists now, and what is still unproven

`desktop/scripts/release-assets.mjs` (tests: `desktop/test/release-assets.test.mjs`), used by BOTH
`publish-github.sh` and the Windows workflow (the `softprops/action-gh-release` step is gone):

| Proposed | Built |
|---|---|
| 1 draft-first | `ensure-draft` runs before the tag push; CI uploads into the draft; `publish` is the only go-live |
| 2 manifests last | `upload` sorts `*.yml` after everything else |
| 3 verify before the flip | `problems()` — every file named by both channel manifests + the Mac DMG, `uploaded`, manifest size; then public-URL 200s after the flip |
| 4 self-healing uploads | clears `starter` assets, 20-min timeout, 3 tries, success = GitHub's sha256 `digest` == local file; CI step `timeout-minutes: 75` |
| 5 rollback | failed live check → re-draft (fallback: delete manifests) |
| 6 update-error telemetry | already existed (`updLog('ERROR …')`) |
| 8 runbook | "If a release goes wrong" in `docs/release-runbook.md` |

**Partial-download question (answered from electron-updater 6.8.9 source, `AppUpdater.js`
`executeDownload`):** the installer downloads to `temp-<name>`, is renamed to its final name only
after the download task (which checks sha512) succeeds, any error deletes it, and
`validateDownloadedPath` re-hashes the file before install. A missing or truncated installer can't be
run. Not reproduced on a live Windows client.

**Exercised for real:** on a throwaway draft (`0.0.1-beta.0`, since deleted; no tag pushed) —
draft creation + reuse, manifest-last ordering, skip-if-identical, replace-if-different, the
incomplete-release refusals, and draft invisibility (absent from `releases.atom`, "Latest"
unchanged). GitHub threw the real `HTTP 500: Error saving asset` + `starter` on a **250 KB** file
during that test and the tool cleared it and succeeded on try 2 — so the GitHub fault is not
size-related. `verify --live` passes against the real 0.2.60 and 0.2.60-beta.1 releases.

**NOT yet exercised:** the draft→public flip, the post-flip check, and the rollback (they can only run
on a real release), and the new CI upload step on a Windows runner. **Cut the next release as a beta
first and watch these.** Still open: #7 smaller files (Phase 7b), and the upload-slowness root cause
(only one comparison was made; "GitHub throttling" is a guess).
