// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host: the
// focused repo's resolution, then the list requests on top of it.
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { GhError, type Gh } from './gh'
import * as main from './worker'
import type { GhRepoAnswer } from './repo'

const noGh: Gh = async () => {
  throw new Error('no gh call expected')
}

const workspaces = [
  { id: 'w-app', kind: 'worktree', name: 'main', project: 'app', path: '/code/app', branch: 'main', hostId: null },
  { id: 'w-lib', kind: 'worktree', name: 'main', project: 'lib', path: '/code/lib', branch: 'main', hostId: null },
  { id: 'w-spike', kind: 'worktree', name: 'Spike', project: 'app', path: '/work/spike', branch: 'feature/spike', hostId: 'local' },
  { id: 'w-gl', kind: 'folder', name: 'gl', project: 'gl', path: '/code/gl', branch: 'main', hostId: null },
  { id: 'w-out', kind: 'worktree', name: 'out', project: 'out', path: '/code/out', branch: 'main', hostId: null }
]
const repos: Record<string, GhRepoAnswer> = {
  '/code/app': { ok: true, nameWithOwner: 'octo/app', url: 'https://github.com/octo/app' },
  '/work/spike': { ok: true, nameWithOwner: 'octo/app', url: 'https://github.com/octo/app' },
  '/code/gl': { ok: false, error: { code: 'not_a_repo', message: 'none of the git remotes point to a known GitHub host' } },
  '/code/out': { ok: false, error: { code: 'gh_logged_out', message: 'gh auth login' } }
}

function repoWorker(gh: string[] = []) {
  return {
    default: (orca: OrcaWorkerApi) =>
      main.activateWith(orca, {
        gh: noGh,
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
  assert.deepEqual(await worker.request('repo.get'), { ok: true, nameWithOwner: 'octo/app', url: 'https://github.com/octo/app', path: '/work/spike', resolvedBy: 'context' })
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
  let focused = { branch: 'feature/spike', displayName: 'Spike', terminals: [] as { id: string }[] }
  const host = mockHost({
    results: { 'workspace.readContext': () => focused, 'workspace.list': { workspaces, truncated: false } }
  })
  const focus = (context: typeof focused) => {
    focused = context
    return worker.emit('workspace.changed', { context })
  }
  // Orca first sends the current context (spike) to a new subscriber.
  const worker = await mountWorker(repoWorker(gh), { host })
  await focus({ branch: 'main', displayName: 'gl', terminals: [] })
  await focus({ branch: 'main', displayName: 'gl', terminals: [{ id: 't1' }] })
  await focus({ branch: 'feature/spike', displayName: 'Spike', terminals: [] })
  await focus({ branch: 'main', displayName: 'gl', terminals: [] })

  const codes = worker.posts.filter((p) => p.event === 'repo.changed').map((p) => {
    const answer = p.payload as { ok: boolean; nameWithOwner?: string; error?: { code: string } }
    return answer.ok ? answer.nameWithOwner : answer.error?.code
  })
  assert.deepEqual(codes, ['octo/app', 'not_a_repo', 'octo/app', 'not_a_repo'])
  // A found repo is kept; not_a_repo is asked again, as a remote may have been added since.
  assert.deepEqual([...gh].sort(), ['/code/gl', '/code/gl', '/code/gl', '/work/spike'])
  const answer = await worker.request('repo.get')
  assert.equal(!answer.ok && answer.error.code, 'not_a_repo')
  await worker.deactivate()
})

test('gh errors are not cached, so a later login is picked up', async () => {
  const gh: string[] = []
  const worker = await mountWorker(repoWorker(gh), { host: hostFocused({ branch: 'main', displayName: 'out' }) })
  assert.equal(((await worker.request('repo.get')) as { error?: { code: string } }).error?.code, 'gh_logged_out')
  await worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'out', terminals: [{ id: 't9' }] } })
  // The first subscriber event, the retry repo.get makes after that error, then the new event.
  assert.deepEqual(gh, ['/code/out', '/code/out', '/code/out'])
  await worker.deactivate()
})

test('an answer for a focus that already moved on is dropped', async () => {
  let release: () => void = () => {}
  const slow = new Promise<void>((resolve) => (release = resolve))
  const module = {
    default: (orca: OrcaWorkerApi) =>
      main.activateWith(orca, {
        gh: noGh,
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
        gh: noGh,
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

test('repo.get asks again after an error, with no focus change', async () => {
  const gh: string[] = []
  let loggedIn = false
  const module = {
    default: (orca: OrcaWorkerApi) =>
      main.activateWith(orca, {
        gh: noGh,
        ghRepo: async (path) => {
          gh.push(path)
          return loggedIn ? { ok: true, nameWithOwner: 'octo/out', url: 'https://github.com/octo/out' } : repos[path]
        },
        terminalPath: async () => null,
        exists: () => true
      })
  }
  const worker = await mountWorker(module, { host: hostFocused({ branch: 'main', displayName: 'out' }) })
  const first = await worker.request('repo.get')
  assert.equal(!first.ok && first.error.code, 'gh_logged_out')
  loggedIn = true
  assert.deepEqual(await worker.request('repo.get'), { ok: true, nameWithOwner: 'octo/out', url: 'https://github.com/octo/out', path: '/code/out', resolvedBy: 'context' })
  // Other open panels hear the new answer too.
  const last = worker.posts.filter((p) => p.event === 'repo.changed').at(-1)
  assert.equal((last?.payload as { ok: boolean }).ok, true)
  // A found repo is served from cache.
  await worker.request('repo.get')
  assert.equal(gh.length, 3)
  await worker.deactivate()
})

function listWorker(gh: Gh) {
  return {
    default: (orca: OrcaWorkerApi) =>
      main.activateWith(orca, { gh, ghRepo: async (path) => repos[path], terminalPath: async () => null, exists: () => true })
  }
}

test('issues.list runs one gh search in the focused repo and answers its page', async () => {
  const calls: { args: string[]; cwd?: string; signal?: AbortSignal }[] = []
  const gh: Gh = async (args, options) => {
    calls.push({ args, cwd: options?.cwd, signal: options?.signal })
    return {
      data: {
        page: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        open: { issueCount: 1 },
        closed: { issueCount: 0 }
      }
    }
  }
  const worker = await mountWorker(listWorker(gh), { host: hostFocused({ branch: 'feature/spike', displayName: 'Spike' }) })
  const answer = await worker.request('issues.list', { state: 'open', query: '', after: null })
  assert.deepEqual(answer, { ok: true, rows: [], total: 1, open: 1, closed: 0, next: null, limit: 1000 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cwd, '/work/spike')
  assert.ok(calls[0].args.includes('q=repo:octo/app is:issue is:open sort:created-desc'))
  // The request's own signal reaches gh, so a closed panel stops it.
  assert.ok(calls[0].signal instanceof AbortSignal)
  await worker.deactivate()
})

test('a list asked with no repo answers the repo error and never runs gh', async () => {
  const worker = await mountWorker(listWorker(noGh), { host: hostFocused({ branch: 'main', displayName: 'out' }) })
  const answer = await worker.request('pulls.list', { state: 'open', query: '', after: null })
  assert.equal(answer.ok, false)
  if (answer.ok) return
  assert.equal(answer.error.code, 'gh_logged_out')
  assert.equal(answer.error.path, '/code/out')
  await worker.deactivate()
})

test('a gh failure in a list is an answer, not a thrown error', async () => {
  const gh: Gh = async () => {
    throw new GhError('rate_limited', 'API rate limit exceeded for user ID 1.')
  }
  const worker = await mountWorker(listWorker(gh), { host: hostFocused({ branch: 'feature/spike', displayName: 'Spike' }) })
  const answer = await worker.request('runs.list', { query: '', after: null })
  assert.deepEqual(answer, { ok: false, error: { code: 'rate_limited', message: 'API rate limit exceeded for user ID 1.' } })
  await worker.deactivate()
})

test('runs.list with plain words answers bad_query without running gh', async () => {
  const worker = await mountWorker(listWorker(noGh), { host: hostFocused({ branch: 'feature/spike', displayName: 'Spike' }) })
  const answer = await worker.request('runs.list', { query: 'flaky test', after: null })
  assert.equal(!answer.ok && answer.error.code, 'bad_query')
  await worker.deactivate()
})
