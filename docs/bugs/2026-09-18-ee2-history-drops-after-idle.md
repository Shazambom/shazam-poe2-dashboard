# BUG — EE2 History drops every price check for 5 minutes after a 10-minute pause

**Status:** OPEN — diagnosed from telemetry + code, not yet fixed (owner: write it up, don't fix) ·
**Severity:** medium — silent data loss in the ExiledExchange2 History stream: the item the user just
price-checked never appears in the workspace, with no error shown; the feature looks flaky ·
**Found:** 2026-09-18 while reading the beta telemetry window (0.2.61-beta.2, win32) ·
**Affects:** every build since the EE2 History actions layer shipped (Batch 2, `14e5023`); both
platforms (the logic is in `desktop/src/ee2-history/`, not platform code).

## What was seen

Marker `ee2`, 0.2.61-beta.2 win32, 2026-09-17 UTC (server clock):

```
23:39:19  item-checked … "Hypnotic Visage"   → history-build … ms=1 qb=1106 → history-add total=33
          (12 quiet minutes: two Backslash hotkeys at 23:39–23:40, nothing else)
23:51:33  item-checked rarity=Currency name="Sacred Bloom"        → history-skip reason=worker origin=ee2
23:51:47  item-checked rarity=Currency name="Exalted Orb"         → history-skip reason=worker origin=ee2
23:51:49  item-checked rarity=Currency name="Sacred Bloom"        → history-skip reason=worker origin=ee2
23:52:47  item-checked rarity=Unique   name="Maligaro's Virtuosity" → history-skip reason=worker origin=ee2
23:53:21  item-checked rarity=Gem      name="Refutation"          → history-skip reason=worker origin=ee2
23:53:44  item-checked rarity=Gem      name="Refutation"          → history-skip reason=worker origin=ee2
```

Six consecutive price checks dropped. No `err=`, no `spawn=`, no `warm` line, no `history-degraded`
— the worker was never asked to build. The skips start 12 min after the last build and stop being
possible ~15 min after it (nothing was checked between 23:53:44 and the next `checking` at 00:03).

## Cause (confirmed in code)

Two independent rules collide:

1. **The worker exits itself after 10 idle minutes** — `desktop/src/ee2-history/worker-host.js:8`
   `IDLE_EXIT_MS = 10 * 60 * 1000`; `touch()` at `:33` arms a timer that calls `kill()`. This is by
   design (don't keep a utilityProcess alive forever); the header comment says it "is re-spawned on the
   next use".
2. **Any worker exit is treated as a failure.** The child's `exit` event (`worker-host.js:23`) runs
   `fail(new Error('worker exited'))`, which calls `onExit()` (`:22`). The consumer's `onExit`
   (`desktop/src/ee2-history/index.js:33`) does `proc = null; lastFailure = now()`. `ensureWorker()`
   (`index.js:31`) then returns `null` for `RESTART_MIN_MS` = 5 min (`index.js:12`), and `buildIntent`
   (`index.js:51`) logs `history-skip reason=worker` and returns nothing.

So the timeline is: last build at T → idle kill at T+10 min → restart throttle until T+15 min → every
price check in [T+10, T+15] is dropped. In the log: T = 23:39:19, skips 23:51:33–23:53:44, all inside
[23:49:19, 23:54:19]. The pattern is deterministic: **any pause of 10–15 minutes between price checks
loses the next ones.** A user who tabs out to fight for ten minutes and comes back to price-check a drop
hits it every time.

Contributing gaps:

- The idle kill logs nothing, so the telemetry shows a healthy worker and then unexplained skips. The
  line-51 skip carries no `err=`, so it is indistinguishable from a real spawn/build failure.
- `RESTART_MIN_MS` (5 min) was sized for the crash case (a worker that dies on spawn shouldn't be
  respawned per keystroke); it was never meant to apply to a planned exit.
- The unit tests (`desktop/test/ee2-history.test.mjs`) cover the restart throttle after an injected
  *failure* but not the idle-exit → next-use path, so the collision was never exercised.

## Not the cause (ruled out)

- Not the Windows worker binary / asar unpack: the same worker built "Hypnotic Visage" 12 min earlier
  and warmed in 36 ms at 23:33:56.
- Not currency-kind items: `reason=currency` is a distinct log line (`index.js:64`) and a Unique and a
  Gem were dropped too.
- Not the renderer / no-window buffer: those log `ingest-drop`, not `history-skip`.

## Proposed fix (not implemented)

Make the planned exit distinguishable from a crash, e.g. `worker-host.js`: `kill()` sets a
`stopping` flag and the `exit` handler calls `onExit({ idle: true })` in that case; `index.js`'s
`onExit` only sets `lastFailure` when `!idle`. Log the idle exit once (`history-worker idle-exit`) so
the telemetry shows it. Test first: spawn → build → advance the clock past `IDLE_EXIT_MS` → build again
must succeed immediately (today it returns `null`). Optionally also make the line-51 skip say
`reason=throttled` so a throttle and a spawn failure never share a label again.

## Telemetry that found it

The `ee2` marker's per-event lines (`item-checked` / `history-build` / `history-skip`) with server-side
timestamps. Without the 12-minute gap being visible in the same stream this would have looked like a
random worker failure — keep the per-event granularity.
