# 2026-09-25: the market seed never applied on Windows

**Symptom.** After 0.3.6-beta.1 a Windows client showed an empty Mods tab and what looked like a
full market sync on every launch.

**What telemetry showed** (beta.2 added a `[seed]` line to the seed step):

```
[seed]: replacing local v0 with seed v1790363310 (88 MB gz)
[seed]: FAILED (OSError: [Errno 9] Bad file descriptor); crawling live
[mods]: snapshot v0 pools=0 currencies=0
```

`local v0` is a crawl-built DB with no snapshot version: the seed had never applied on that
machine. Every launch decompressed the 88 MB seed, failed, and fell back to the live crawl.

**Cause.** `db.seed_market` copied the seed to a temp file, then reopened it read-only to
`os.fsync` it. On Windows `os.fsync` on a read-only handle fails with EBADF. POSIX allows it,
so the Mac never saw it, and the failure was logged only to the backend's stdout.

**Fix** (0.3.6-beta.3): flush and sync through the handle the copy was written with;
`test_seed_market_syncs_through_the_write_handle` pins that the synced handle is writable.

**Reproduction on any platform:** `backend/tests/test_seed_windows.py` runs the seed step under a
Windows-like `os.fsync` (EBADF on a read-only handle). Against the pre-fix code the fresh-install
and unseeded-client cases fail with the exact telemetry line above; against the fix they seed,
the mod tables arrive, and the `[seed]` lines read `replacing … / replaced: now v…`. A failed seed
keeps the previous DB, leaves no temp file and reports `FAILED`.

**Lessons.**
- A silent fallback ("will crawl live") hid a platform bug for weeks. The seed step now reports
  kept / replaced / failed over beta telemetry, and the mod-table counts at startup.
- The league crawl walks every league's item list at about ten items a second even when it
  skips them all, so a seeded client still shows "crawling N/500" for a minute per league. It is
  bookkeeping, not fetching, but it reads as a full sync. Worth counting only fetch candidates.
