// ghRepo over a fake gh, plus one run against the real gh and git.
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import { GhError, runGh, type Gh } from '../../../src/worker/gh'
import { ghRepo } from '../../../src/worker/repo/repo'

function answering(answer: unknown): Gh & { calls: unknown[][] } {
  const calls: unknown[][] = []
  const gh: Gh = async (args, options) => {
    calls.push([args, options?.cwd])
    if (answer instanceof Error) throw answer
    return answer
  }
  return Object.assign(gh, { calls })
}

test('ghRepo answers nameWithOwner and url from gh repo view in the folder', async () => {
  const gh = answering({ nameWithOwner: 'octo/app', url: 'https://github.com/octo/app' })
  assert.deepEqual(await ghRepo('/code/app', gh), { ok: true, nameWithOwner: 'octo/app', url: 'https://github.com/octo/app' })
  assert.deepEqual(gh.calls, [[['repo', 'view', '--json', 'nameWithOwner,url'], '/code/app']])
})

test('ghRepo passes on the code of a gh failure', async () => {
  const answer = await ghRepo('/code/gl', answering(new GhError('not_a_repo', 'no git remotes found')))
  assert.deepEqual(answer, { ok: false, error: { code: 'not_a_repo', message: 'no git remotes found' } })
})

test('ghRepo: output without nameWithOwner', async () => {
  const answer = await ghRepo('/code/app', answering({ url: 'https://github.com/octo/app' }))
  assert.equal(!answer.ok && answer.error.code, 'gh_failed')
})

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Real gh, real git: GH_LIVE=1 orca plugin test . (needs gh logged in and network).
test('live: gh resolves this repo, and a folder with no remote is not a repo', async () => {
  if (process.env.GH_LIVE !== '1' || !has('gh') || !has('git')) return
  const gh: Gh = (args, options) => runGh(args, options)
  const here = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const result = await ghRepo(here, gh)
  assert.equal(result.ok && result.nameWithOwner, 'chimeyrock999/orca-github-plugins')

  const bare = mkdtempSync(join(tmpdir(), 'github-plugin-'))
  execFileSync('git', ['init', '-q', bare])
  const empty = await ghRepo(bare, gh)
  assert.equal(!empty.ok && empty.error.code, 'not_a_repo')
})
