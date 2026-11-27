// ghRepo over a fake gh, plus one run against the real gh and git; then the tracker on a host that
// names the focused workspace by id.
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import * as main from '../../../src/worker'
import { GhError, runGh, type Gh } from '../../../src/worker/gh'
import { ghRepo } from '../../../src/worker/repo/repo'
import { noGh, repos, workspaces } from '../../fixtures/worker-fixtures'

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

// trackRepo through the real worker: readContext and workspace.changed name the focused workspace by
// the id workspace.list gives, so the focus needs no Orca CLI and nothing stored.

function idWorker() {
  return {
    default: (orca: OrcaWorkerApi) => main.activateWith(orca, { gh: noGh, ghRepo: async (path) => repos[path], exists: () => true })
  }
}

test('two repos on main resolve by id', async () => {
  const context = { workspaceId: 'w-app', branch: 'main', displayName: 'main', terminals: [{ id: 't1' }] }
  const host = mockHost({ results: { 'workspace.readContext': context, 'workspace.list': { workspaces, truncated: false } } })
  const worker = await mountWorker(idWorker(), { host })
  assert.deepEqual(await worker.request('repo.get'), {
    ok: true,
    nameWithOwner: 'octo/app',
    url: 'https://github.com/octo/app',
    path: '/code/app',
    workspaceId: 'w-app'
  })
  await worker.deactivate()
})

test('workspace.changed moves the focus by id', async () => {
  let context = { workspaceId: 'w-spike', branch: 'feature/spike', displayName: 'Spike', terminals: [] as { id: string }[] }
  const host = mockHost({ results: { 'workspace.readContext': () => context, 'workspace.list': { workspaces, truncated: false } } })
  const worker = await mountWorker(idWorker(), { host })
  assert.equal((await worker.request('repo.get')).ok, true)
  context = { workspaceId: 'w-gl', branch: 'main', displayName: 'main', terminals: [{ id: 't1' }] }
  await worker.emit('workspace.changed', { context })
  const answer = await worker.request('repo.get')
  assert.equal(!answer.ok && answer.error.code, 'not_a_repo')
  assert.equal(!answer.ok && answer.error.path, '/code/gl')
  await worker.deactivate()
})

test('an id missing from a cut workspace.list says the list was cut', async () => {
  const context = { workspaceId: 'w-later', branch: 'main', displayName: 'main', terminals: [] }
  const host = mockHost({ results: { 'workspace.readContext': context, 'workspace.list': { workspaces, truncated: true } } })
  const worker = await mountWorker(idWorker(), { host })
  const answer = await worker.request('repo.get')
  assert.equal(!answer.ok && answer.error.code, 'workspace_not_found')
  assert.match(!answer.ok ? answer.error.message : '', /listed only part/)
  await worker.deactivate()
})

test('a context with no id is not found, even with one workspace on its branch and name', async () => {
  const context = { branch: 'feature/spike', displayName: 'Spike', terminals: [{ id: 't1' }] }
  const host = mockHost({ results: { 'workspace.readContext': context, 'workspace.list': { workspaces, truncated: true } } })
  const worker = await mountWorker(idWorker(), { host })
  const answer = await worker.request('repo.get')
  assert.equal(!answer.ok && answer.error.code, 'workspace_not_found')
  // A cut list is not the reason: Orca named no workspace.
  assert.ok(!answer.ok && !/listed only part/.test(answer.error.message))
  await worker.deactivate()
})
