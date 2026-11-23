// ops/pull-ee2-items.sh pipes `ssh "$HOST" ...` into Python to split install-reports.log
// into per-item text files and queries.txt. Verify the pipe actually reaches Python's stdin
// (regression guard for SC2259, where a heredoc stole stdin from the pipe).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = new URL('../..', import.meta.url).pathname

test('ops/pull-ee2-items.sh parses piped ssh log into item files and queries.txt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pull-ee2-items-'))
  mkdirSync(join(dir, 'ops'), { recursive: true })
  mkdirSync(join(dir, 'bin'), { recursive: true })
  cpSync(join(ROOT, 'ops/pull-ee2-items.sh'), join(dir, 'ops/pull-ee2-items.sh'))

  const sampleLog = [
    '===== 2026-10-05 12:00:00 from 1.2.3.4 =====',
    'v0.3.18-beta.1 win32 origin=clipboard',
    'Item Class: Rings',
    'Rarity: Rare',
    'Loath Loop',
    'Ruby Ring',
    '===== 2026-10-05 12:00:05 from 1.2.3.4 =====',
    'v0.3.18-beta.1 win32 origin=clipboard',
    'Item Class: Rings',
    'Rarity: Rare',
    'Loath Loop',
    'Ruby Ring',
    '===== 2026-10-05 12:01:00 from 1.2.3.4 =====',
    'v0.3.18-beta.1 win32 origin=history name="Ruby Ring"',
    'https://www.pathofexile.com/trade2/search/poe2/Standard/abc123',
    '',
  ].join('\n')

  writeFileSync(join(dir, 'sample.log'), sampleLog)
  writeFileSync(
    join(dir, 'bin/ssh'),
    `#!/bin/bash
printf '%s\\n' "$@" > "${dir}/ssh-args.txt"
cat "${dir}/sample.log"
`,
  )
  chmodSync(join(dir, 'bin/ssh'), 0o755)

  const r = spawnSync('bash', [join(dir, 'ops/pull-ee2-items.sh')], {
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      SHAZAM_HOST: 'fake-shazam',
      SHAZAM_INSTALL_LOG: '/var/log/install-reports.log',
    },
    encoding: 'utf8',
  })

  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /1 item text\(s\), 1 search URL\(s\)/)

  const liveDir = join(dir, 'desktop/test/fixtures/ee2/live')
  const itemText = readFileSync(join(liveDir, '001-clipboard.txt'), 'utf8')
  assert.equal(itemText, 'Item Class: Rings\nRarity: Rare\nLoath Loop\nRuby Ring\n')

  const queries = readFileSync(join(liveDir, 'queries.txt'), 'utf8')
  assert.equal(
    queries,
    '2026-10-05 12:01:00 from 1.2.3.4\thistory\tRuby Ring\thttps://www.pathofexile.com/trade2/search/poe2/Standard/abc123\n',
  )

  const sshArgs = readFileSync(join(dir, 'ssh-args.txt'), 'utf8').trim().split('\n')
  assert.equal(sshArgs[0], 'fake-shazam')
  assert.match(sshArgs.slice(1).join(' '), /\/var\/log\/install-reports\.log/)
})
