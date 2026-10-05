# Release notes — how to write them

Every **stable** release has `docs/release-notes/<x.y.z>.md`. `publish-github.sh` refuses a stable release
without one, checking it with `ops/release_notes.py check`. Once the release is confirmed live, the
feedback bot posts it in Discord `#releases`, tagging `@notifier` and linking that release's Windows and Mac
installers (`ops/announce.sh`).

## The file

```
# 0.3.12

One or two short sentences that sum up every bullet.

- A few words each
- User-facing only
```

## The owner's rules (2026-10-04)

> "The patch notes should be only bullet points and very user focused (under the hood stuff can be omitted)
> and a very very very brief summary for each release that encapsulates all of the patch notes bullet points.
> Bullet points should be like short brief commit messages, no more than a few words. The summary should be 1
> to two short sentences depending on the features released."

- **Summary:** one or two short sentences, depending on the size of the release. It covers every bullet,
  so a reader who stops there knows what changed.
- **Bullets:** like short commit messages. A few words each, at most 7, with no closing period.
- **User-facing only:** what a player sees or can now do. Leave out internals: tests, refactors, telemetry,
  build and release plumbing, rate-limit bookkeeping.
- **Written from the commits since the last stable release** (`git log desktop-v<prev>..HEAD`), merging a
  feature's many commits into one bullet.
- **The owner sees the draft before every stable ship** and the release waits for their OK.

`ops/release_notes.py` enforces the shape: the heading, at most two sentences, at most 12 bullets, the word
and character limits, and one Discord message. Tone and choice of words are this file's job.

## Lessons from the owner's corrections

After every correction to a draft, ask: can I learn from this correction and distil it into a general rule?
If so, add the rule here, dated, in the same change as the corrected notes.

- **2026-10-04 (0.3.12): the summary names what changed; it doesn't explain how anything works.** Write it as
  a plain headline built from areas a player recognises: "Stash UI redesign and minor bug fixes to sales
  currency counting and strat calculator tablet/waystone pricing." Call a redesign a redesign and a fix a bug
  fix, naming the area. Don't assume the reader knows the app's concepts or mechanics: my draft, "your stash
  now shows holdings by league mechanic with your liquid net worth; arbitrage, sales and the Strat Calculator
  all use it correctly", did. The same goes for bullets: a bullet that only makes sense if you know how a
  feature works internally ("Arbitrage trades only liquid currency") should say what the player sees instead.
- **2026-10-05 (0.3.13): keep the summary to the plain headline; no sweeping scope words.** "Smarter search in every
  search bar, plus arrow-key scrolling in search lists" became "Smarter search and arrow-key scrolling in search
  lists." Name the things that changed and stop: drop qualifiers like "every", "all" or "across the app", which
  overclaim and add length without telling a player anything the bullets don't.
- **2026-10-05 (0.3.14): a new default that replaces users' saved values is not announced.** The Balanced preset
  replaced every user's Arbitrage settings on upgrade; the owner left that out of the notes ("Leave out the reset of
  settings"). Announce what players gain, not that a better default overwrote their old numbers.
