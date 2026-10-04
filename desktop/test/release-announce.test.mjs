// Owner, 2026-10-04: a stable release is announced in Discord #releases (tagging @notifier) with its patch
// notes, "built to trigger automatically during the build and release process and should only fire after
// confirmed released". publish-github.sh refuses a stable release without good notes before anything
// remote, and announces only once the release is live on both platforms (ops/announce.sh confirms again).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sh = readFileSync(new URL('../publish-github.sh', import.meta.url), 'utf8')
const at = (s) => { const i = sh.indexOf(s); assert.ok(i >= 0, `missing: ${s}`); return i }

test('a stable release needs good release notes before anything is pushed or built', () => {
  const check = at('../ops/release_notes.py check "$VER"')
  assert.ok(check < at('git push origin main'), 'checked before main goes up')
  const line = sh.slice(sh.lastIndexOf('\n', check), sh.indexOf('\n', check))
  assert.match(line, /case "\$VER" in \*-beta\*\) ;;/, 'stable only: a beta needs no notes')
})

test('the announcement fires only after the release is confirmed live, and only for stable', () => {
  const live = at('echo "release $TAG is live on both platforms"')
  const ann = at('../ops/announce.sh "$TAG"')
  assert.ok(ann > live, 'announced after go-live')
  const line = sh.slice(sh.lastIndexOf('\n', ann), sh.indexOf('\n', ann))
  assert.match(line, /case "\$VER" in \*-beta\*\) ;;/, 'never for a beta')
  assert.match(sh.slice(ann, ann + 300), /\|\| echo "WARNING/, 'a failed announcement never fails the live release')
})

test("before pushing, the notes are committed as announced and shazam's bot accepts them", () => {
  const push = at('git push origin main')
  const committed = at('git ls-files --error-unmatch "docs/release-notes/$VER.md"')
  const clean = at('git diff --quiet HEAD -- "docs/release-notes/$VER.md"')
  const remote = at('../ops/announce.sh check "desktop-v$VER"')
  for (const i of [committed, clean, remote]) assert.ok(i < push, 'checked before main goes up')
  for (const i of [committed, remote]) {
    const line = sh.slice(sh.lastIndexOf('\n', i), sh.indexOf('\n', i))
    assert.match(line, /case "\$VER" in \*-beta\*\) ;;/, 'stable only')
  }
})
