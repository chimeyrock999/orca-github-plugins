// Checks a release tag the way RELEASING.md asks, and prints its CHANGELOG section as the notes
// of its GitHub Release. Run by .github/workflows/release.yml; by hand:
//   node .github/release-check.mjs v0.1.2 origin/main
//   node .github/release-check.mjs --notes-only v0.1.2    # the notes, without the checks
// Reads the tagged commit through git, not the working tree, so any checkout works.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PLUGIN = 'plugins/gh-focus'
const MANIFEST = `${PLUGIN}/orca-plugin.json`

// The text under `## <version>` (with or without ` - <date>`) up to the next `## `, trimmed;
// null when there is no such heading.
export function changelogSection(changelog, version) {
  const lines = changelog.split('\n')
  const heading = new RegExp(`^## ${version.replaceAll('.', '\\.')}(\\s|$)`)
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()
}

// The tagged commit and a reader of its files and history.
function tagged(tag, cwd) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`${tag} is not a release tag (vX.Y.Z)`)
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  let sha
  try {
    sha = git('rev-parse', '--verify', '--quiet', `${tag}^{commit}`).trim()
  } catch {
    throw new Error(`there is no tag ${tag}`)
  }
  return { version: tag.slice(1), sha, git }
}

// The version's CHANGELOG section at the tag, checking nothing else: the notes of a Release made
// by hand when the checks fail on the tagged commit.
export function releaseNotes({ tag, cwd = process.cwd() }) {
  const { version, sha, git } = tagged(tag, cwd)
  const notes = changelogSection(git('show', `${sha}:CHANGELOG.md`), version)
  if (!notes) throw new Error(`CHANGELOG.md at ${tag} has no ## ${version} section, or it is empty`)
  return notes
}

export function checkRelease({ tag, mainRef, cwd = process.cwd() }) {
  const { version, sha, git } = tagged(tag, cwd)
  const isAncestor = (commit, of) => {
    try {
      git('merge-base', '--is-ancestor', commit, of)
      return true
    } catch {
      return false
    }
  }
  const problems = []
  // A file of the tagged commit, or null (and a problem) when the commit has none.
  const read = (path) => {
    try {
      return git('show', `${sha}:${path}`)
    } catch {
      problems.push(`${path} is missing at ${tag}`)
      return null
    }
  }
  const readJson = (path) => {
    const text = read(path)
    if (text === null) return null
    try {
      return JSON.parse(text)
    } catch (error) {
      problems.push(`${path} is not valid JSON at ${tag}: ${error.message}`)
      return null
    }
  }

  const manifest = readJson(MANIFEST)
  if (manifest !== null && manifest.version !== version) {
    problems.push(`${MANIFEST}: version is ${manifest.version}, not ${version}`)
  }

  if (!isAncestor(sha, mainRef)) problems.push(`${tag} (${sha}) is not on ${mainRef}`)

  const changelog = read('CHANGELOG.md')
  const notes = changelog === null ? null : changelogSection(changelog, version)
  if (changelog !== null && notes === null) problems.push(`CHANGELOG.md has no ## ${version} section`)
  else if (notes === '') problems.push(`CHANGELOG.md: the ## ${version} section is empty`)

  const catalog = readJson('orca-catalog.json')
  const plugin = catalog?.plugins?.find((p) => p.source?.path === PLUGIN)
  const entry = plugin?.releases?.find((r) => r.version === version)
  if (catalog !== null && !plugin) problems.push(`orca-catalog.json has no plugin with source.path ${PLUGIN}`)
  else if (plugin && !entry) problems.push(`orca-catalog.json has no release ${version}`)
  else if (entry && !isAncestor(entry.commit, sha)) {
    problems.push(`orca-catalog.json: release ${version} names commit ${entry.commit}, which is not in the history of ${tag}`)
  }

  if (problems.length > 0) throw new Error(problems.join('\n'))
  return { version, notes }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const notesOnly = args[0] === '--notes-only'
  const [tag = '', mainRef = 'origin/main'] = notesOnly ? args.slice(1) : args
  try {
    const notes = notesOnly ? releaseNotes({ tag }) : checkRelease({ tag, mainRef }).notes
    process.stdout.write(`${notes}\n`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
