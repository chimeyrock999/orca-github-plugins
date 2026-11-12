// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import * as main from './worker'
import type { GhRepoAnswer } from './exec'

test('adds to the stored total and tells open panels', async () => {
  const host = mockHost({ storage: { total: 2 } })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await worker.request('counter.get'), { total: 2 })
  assert.deepEqual(await worker.request('counter.add', { by: 3 }), { total: 5 })
  assert.deepEqual(worker.posts.filter((p) => p.event === 'counter.changed'), [{ event: 'counter.changed', payload: { total: 5 } }])
  assert.deepEqual(host.data().storage, { total: 5 })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

const workspaces = [
  { id: 'w-app', kind: 'worktree', name: 'main', project: 'app', path: '/code/app', branch: 'main', hostId: null },
  { id: 'w-lib', kind: 'worktree', name: 'main', project: 'lib', path: '/code/lib', branch: 'main', hostId: null },
  { id: 'w-spike', kind: 'worktree', name: 'Spike', project: 'app', path: '/work/spike', branch: 'feature/spike', hostId: 'local' },
  { id: 'w-gl', kind: 'folder', name: 'gl', project: 'gl', path: '/code/gl', branch: 'main', hostId: null },
  { id: 'w-out', kind: 'worktree', name: 'out', project: 'out', path: '/code/out', branch: 'main', hostId: null }
]
const repos: Record<string, GhRepoAnswer> = {
  '/code/app': { ok: true, nameWithOwner: 'octo/app' },
  '/work/spike': { ok: true, nameWithOwner: 'octo/app' },
  '/code/gl': { ok: false, error: { code: 'not_a_repo', message: 'none of the git remotes point to a known GitHub host' } },
  '/code/out': { ok: false, error: { code: 'gh_logged_out', message: 'gh auth login' } }
}

function repoWorker(gh: string[] = []) {
  return {
    default: (orca: OrcaWorkerApi) =>
      main.activateWith(orca, {
        ghRepo: async (path) => {
          gh.push(path)
          return repos[path]
        },
        terminalPath: async () => null,
        exists: () => true
      })
  }
}

function hostFocused(context: { branch: string; displayName: string } | null) {
  return mockHost({
    results: {
      'workspace.readContext': context && { ...context, terminals: [] },
      'workspace.list': { workspaces, truncated: false }
    }
  })
}

test('repo.get answers the focused workspace repo and its path', async () => {
  const worker = await mountWorker(repoWorker(), { host: hostFocused({ branch: 'feature/spike', displayName: 'Spike' }) })
  assert.deepEqual(await worker.request('repo.get'), { ok: true, nameWithOwner: 'octo/app', path: '/work/spike', resolvedBy: 'context' })
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})

test('repo.get passes on the gh error for a folder that is not on GitHub', async () => {
  const worker = await mountWorker(repoWorker(), { host: hostFocused({ branch: 'main', displayName: 'gl' }) })
  const answer = await worker.request('repo.get')
  assert.equal(answer.ok, false)
  if (answer.ok) return
  assert.equal(answer.error.code, 'not_a_repo')
  assert.equal(answer.error.path, '/code/gl')
  await worker.deactivate()
})

test('repo.get with nothing focused', async () => {
  const worker = await mountWorker(repoWorker(), { host: hostFocused(null) })
  const answer = await worker.request('repo.get')
  assert.equal(!answer.ok && answer.error.code, 'no_workspace')
  await worker.deactivate()
})

test('follows workspace.changed and tells panels only when the answer changes', async () => {
  const gh: string[] = []
  // Orca first sends the current context (spike) to a new subscriber.
  const worker = await mountWorker(repoWorker(gh), { host: hostFocused({ branch: 'feature/spike', displayName: 'Spike' }) })
  await worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'gl', terminals: [] } })
  await worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'gl', terminals: [{ id: 't1' }] } })
  await worker.emit('workspace.changed', { context: { branch: 'feature/spike', displayName: 'Spike', terminals: [] } })
  await worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'gl', terminals: [] } })

  const codes = worker.posts.filter((p) => p.event === 'repo.changed').map((p) => {
    const answer = p.payload as { ok: boolean; nameWithOwner?: string; error?: { code: string } }
    return answer.ok ? answer.nameWithOwner : answer.error?.code
  })
  assert.deepEqual(codes, ['not_a_repo', 'octo/app', 'not_a_repo'])
  // A found repo is kept; not_a_repo is asked again, as a remote may have been added since.
  assert.deepEqual(gh, ['/work/spike', '/code/gl', '/code/gl', '/code/gl'])
  const answer = await worker.request('repo.get')
  assert.equal(!answer.ok && answer.error.code, 'not_a_repo')
  await worker.deactivate()
})

test('gh errors are not cached, so a later login is picked up', async () => {
  const gh: string[] = []
  const worker = await mountWorker(repoWorker(gh), { host: hostFocused({ branch: 'main', displayName: 'out' }) })
  assert.equal(((await worker.request('repo.get')) as { error?: { code: string } }).error?.code, 'gh_logged_out')
  await worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'out', terminals: [{ id: 't9' }] } })
  assert.deepEqual(gh, ['/code/out', '/code/out'])
  await worker.deactivate()
})

test('an answer for a focus that already moved on is dropped', async () => {
  let release: () => void = () => {}
  const slow = new Promise<void>((resolve) => (release = resolve))
  const module = {
    default: (orca: OrcaWorkerApi) =>
      main.activateWith(orca, {
        ghRepo: async (path) => {
          if (path === '/code/gl') await slow
          return repos[path]
        },
        terminalPath: async () => null,
        exists: () => true
      })
  }
  const worker = await mountWorker(module, { host: hostFocused({ branch: 'main', displayName: 'gl' }) })
  const first = worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'gl', terminals: [] } })
  await worker.emit('workspace.changed', { context: { branch: 'feature/spike', displayName: 'Spike', terminals: [] } })
  release()
  await first
  const posted = worker.posts.filter((p) => p.event === 'repo.changed').map((p) => (p.payload as { ok: boolean }).ok)
  assert.deepEqual(posted, [true])
  const answer = await worker.request('repo.get')
  assert.equal(answer.ok && answer.path, '/work/spike')
  await worker.deactivate()
})

test('a failed host call is an answer, not a thrown error', async () => {
  const host = mockHost({
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'gl', terminals: [] },
      'workspace.list': () => {
        throw hostError('unavailable', 'Orca is restarting')
      }
    }
  })
  const worker = await mountWorker(repoWorker(), { host })
  const answer = await worker.request('repo.get')
  assert.equal(!answer.ok && answer.error.code, 'host_failed')
  await worker.deactivate()
})

test('a truncated workspace list says so when the workspace is not in it', async () => {
  const host = mockHost({
    results: {
      'workspace.readContext': { branch: 'gone', displayName: 'gone', terminals: [] },
      'workspace.list': { workspaces, truncated: true }
    }
  })
  const worker = await mountWorker(repoWorker(), { host })
  const answer = await worker.request('repo.get')
  assert.equal(answer.ok, false)
  if (answer.ok) return
  assert.equal(answer.error.code, 'workspace_not_found')
  assert.match(answer.error.message, /only part/)
  await worker.deactivate()
})

test('one gh run per folder and one CLI run per terminal, posting each answer once', async () => {
  const gh: string[] = []
  const asked: string[] = []
  const module = {
    default: (orca: OrcaWorkerApi) =>
      main.activateWith(orca, {
        ghRepo: async (path) => {
          gh.push(path)
          return repos[path]
        },
        terminalPath: async (id) => {
          asked.push(id)
          return id === 't-app' ? '/code/app' : null
        },
        exists: () => true
      })
  }
  const context = { branch: 'main', displayName: 'main', terminals: [{ id: 't-app' }] }
  const host = mockHost({ results: { 'workspace.readContext': context, 'workspace.list': { workspaces, truncated: false } } })
  const worker = await mountWorker(module, { host })
  const [a, b] = await Promise.all([worker.request('repo.get'), worker.request('repo.get')])
  assert.deepEqual(a, b)
  await worker.emit('workspace.changed', { context })
  await worker.emit('workspace.changed', { context: { ...context, terminals: [{ id: 't-app' }, { id: 't-new' }] } })
  assert.deepEqual(gh, ['/code/app'])
  assert.deepEqual(asked, ['t-app'])
  // The first workspace.changed Orca sends a new subscriber posts the answer once; the same
  // focus again, or a new terminal in it, posts nothing.
  assert.deepEqual(worker.posts.filter((p) => p.event === 'repo.changed').map((p) => p.payload), [a])
  await worker.deactivate()
})
