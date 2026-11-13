// Checks a release tag the way RELEASING.md asks, and prints its CHANGELOG section as the notes
// of its GitHub Release. Run by .github/workflows/release.yml; by hand:
//   node .github/release-check.mjs v0.1.2 origin/main
// Reads the tagged commit through git, not the working tree, so any checkout works.
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MANIFEST = 'plugins/gh-focus/orca-plugin.json'

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

export function checkRelease({ tag, mainRef, cwd = process.cwd() }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`${tag} is not a release tag (vX.Y.Z)`)
  const version = tag.slice(1)
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const isAncestor = (commit, of) => {
    try {
      git('merge-base', '--is-ancestor', commit, of)
      return true
    } catch {
      return false
    }
  }
  let sha
  try {
    sha = git('rev-parse', '--verify', '--quiet', `${tag}^{commit}`).trim()
  } catch {
    throw new Error(`there is no tag ${tag}`)
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

  const manifest = read(MANIFEST)
  const manifestVersion = manifest === null ? null : JSON.parse(manifest).version
  if (manifest !== null && manifestVersion !== version) {
    problems.push(`${MANIFEST}: version is ${manifestVersion}, not ${version}`)
  }

  if (!isAncestor(sha, mainRef)) problems.push(`${tag} (${sha}) is not on ${mainRef}`)

  const changelog = read('CHANGELOG.md')
  const notes = changelog === null ? null : changelogSection(changelog, version)
  if (changelog !== null && notes === null) problems.push(`CHANGELOG.md has no ## ${version} section`)
  else if (notes === '') problems.push(`CHANGELOG.md: the ## ${version} section is empty`)

  const catalog = read('orca-catalog.json')
  const releases = catalog === null ? [] : JSON.parse(catalog).plugins.flatMap((plugin) => plugin.releases ?? [])
  const entry = releases.find((r) => r.version === version)
  if (catalog !== null && !entry) problems.push(`orca-catalog.json has no release ${version}`)
  else if (entry && !isAncestor(entry.commit, sha)) {
    problems.push(`orca-catalog.json: release ${version} names commit ${entry.commit}, which is not in the history of ${tag}`)
  }

  if (problems.length > 0) throw new Error(problems.join('\n'))
  return { version, notes }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [tag, mainRef = 'origin/main'] = process.argv.slice(2)
  try {
    process.stdout.write(`${checkRelease({ tag: tag ?? '', mainRef }).notes}\n`)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
