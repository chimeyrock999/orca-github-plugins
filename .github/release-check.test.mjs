// Tests for release-check.mjs, each on a scratch git repo shaped like this one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changelogSection, checkRelease } from './release-check.mjs'

const CHANGELOG = `# Changelog

## Unreleased

## 0.2.0 - 2026-11-14

### Added

- A thing.

## 0.1.0 - 2026-11-13

### Added

- The first thing.
`

function git(dir, ...args) {
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8' },
  ).trim()
}

function write(dir, { version = '0.2.0', changelog = CHANGELOG, releases = ['0.2.0'], entryCommit } = {}) {
  mkdirSync(join(dir, 'plugins/gh-focus'), { recursive: true })
  writeFileSync(join(dir, 'plugins/gh-focus/orca-plugin.json'), JSON.stringify({ id: 'gh-focus', version }))
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog)
  const entries = releases.map((v) => ({ version: v, commit: entryCommit ?? '0'.repeat(40) }))
  writeFileSync(join(dir, 'orca-catalog.json'), JSON.stringify({ plugins: [{ id: 'x.gh-focus', releases: entries }] }))
}

// A repo whose main holds the version bump commit, then a commit that adds its catalog entry
// (the entry names the bump commit, as `orca plugin release-entry` prints it), tagged.
function repo(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-check-'))
  git(dir, 'init', '-q', '-b', 'main')
  write(dir, { ...options, releases: [] })
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'bump')
  const bump = git(dir, 'rev-parse', 'HEAD')
  write(dir, { entryCommit: bump, ...options })
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'catalog', '--allow-empty')
  git(dir, 'tag', '-a', options.tag ?? 'v0.2.0', '-m', 'tag')
  return dir
}

const run = (dir, tag = 'v0.2.0') => checkRelease({ tag, mainRef: 'main', cwd: dir })

test('a tag that matches the version, sits on main and has its entries passes', () => {
  const { version, notes } = run(repo())
  assert.equal(version, '0.2.0')
  assert.equal(notes, '### Added\n\n- A thing.')
})

test('the notes are the version section only, up to the next version', () => {
  assert.equal(changelogSection(CHANGELOG, '0.1.0'), '### Added\n\n- The first thing.')
  assert.equal(changelogSection(CHANGELOG, '0.2.0'), '### Added\n\n- A thing.')
  assert.equal(changelogSection(CHANGELOG, '0.3.0'), null)
  // 0.1.0 must not match 0.1.01 or 10.1.0
  assert.equal(changelogSection('## 10.1.0\n\nx\n', '0.1.0'), null)
})

test('a tag that is not vX.Y.Z is refused before git runs', () => {
  assert.throws(() => run(repo(), 'v0.2'), /not a release tag/)
  assert.throws(() => run(repo(), 'v0.2.0; rm -rf /'), /not a release tag/)
})

test('a tag that does not exist says so', () => {
  assert.throws(() => run(repo(), 'v0.3.0'), (error) => error.message === 'there is no tag v0.3.0')
})

test('a version that differs from the tag fails', () => {
  assert.throws(() => run(repo({ version: '0.1.9' })), /version is 0\.1\.9, not 0\.2\.0/)
})

test('a tag that is not on main fails', () => {
  const dir = repo()
  const main = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'switch', '-qc', 'side')
  write(dir, { version: '0.2.1', changelog: '## 0.2.1\n\n- x\n', releases: ['0.2.1'], entryCommit: main })
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'side')
  git(dir, 'tag', '-a', 'v0.2.1', '-m', 'tag')
  assert.throws(() => run(dir, 'v0.2.1'), (error) => /^v0\.2\.1 \([0-9a-f]{40}\) is not on main$/.test(error.message))
})

test('a missing or empty CHANGELOG section fails', () => {
  assert.throws(() => run(repo({ changelog: '# Changelog\n\n## 0.1.0\n\n- x\n' })), /CHANGELOG\.md has no ## 0\.2\.0 section/)
  assert.throws(() => run(repo({ changelog: '## 0.2.0\n\n## 0.1.0\n\n- x\n' })), /## 0\.2\.0 section is empty/)
})

test('a missing catalog entry fails', () => {
  assert.throws(() => run(repo({ releases: ['0.1.0'] })), /orca-catalog\.json has no release 0\.2\.0/)
})

test('a tagged commit without the catalog says which file is missing', () => {
  const dir = repo()
  git(dir, 'rm', '-q', 'orca-catalog.json')
  git(dir, 'commit', '-qm', 'drop')
  git(dir, 'tag', '-af', 'v0.2.0', '-m', 'tag')
  assert.throws(() => run(dir), (error) => error.message === 'orca-catalog.json is missing at v0.2.0')
})

test('a catalog entry whose commit is not in the tag history fails', () => {
  assert.throws(() => run(repo({ entryCommit: 'f'.repeat(40) })), /commit ffffff.* is not in the history of v0\.2\.0/)
})

test('every problem is reported at once', () => {
  assert.throws(
    () => run(repo({ version: '0.1.9', releases: [] })),
    (error) => /version is 0\.1\.9/.test(error.message) && /no release 0\.2\.0/.test(error.message),
  )
})
