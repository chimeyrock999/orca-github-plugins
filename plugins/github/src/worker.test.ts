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
  const answer = await worker.request('issues.list', { state: 'open', query: '', after: null })
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

test('repo.pick settles an ambiguous focus, keeps the pick in storage, and repo.unpick forgets it', async () => {
  const host = mockHost({
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
      'workspace.list': { workspaces, truncated: false }
    }
  })
  const worker = await mountWorker(repoWorker(), { host })
  const first = await worker.request('repo.get')
  assert.equal(!first.ok && first.error.code, 'ambiguous_workspace')

  const picked = await worker.request('repo.pick', { path: '/code/app' })
  assert.equal(picked.ok && picked.resolvedBy, 'picked')
  assert.equal(picked.ok && picked.nameWithOwner, 'octo/app')
  assert.deepEqual(host.data().storage, { picks: { 'main\nmain': '/code/app' } })
  // The same focus later still resolves by the pick.
  await worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'main', terminals: [] } })
  assert.equal(((await worker.request('repo.get')) as { resolvedBy?: string }).resolvedBy, 'picked')

  const forgot = await worker.request('repo.unpick')
  assert.equal(!forgot.ok && forgot.error.code, 'ambiguous_workspace')
  assert.deepEqual(host.data().storage, { picks: {} })
  await worker.deactivate()
})

test('a pick stored by an earlier run is used, and a stale one is ignored', async () => {
  const focused = { branch: 'main', displayName: 'main', terminals: [] }
  const host = mockHost({
    storage: { picks: { 'main\nmain': '/code/app' } },
    results: { 'workspace.readContext': focused, 'workspace.list': { workspaces, truncated: false } }
  })
  const worker = await mountWorker(repoWorker(), { host })
  const answer = await worker.request('repo.get')
  assert.equal(answer.ok && answer.path, '/code/app')
  await worker.deactivate()

  const stale = mockHost({
    storage: { picks: { 'main\nmain': '/code/gone' } },
    results: { 'workspace.readContext': focused, 'workspace.list': { workspaces, truncated: false } }
  })
  const again = await mountWorker(repoWorker(), { host: stale })
  const ambiguous = await again.request('repo.get')
  assert.equal(!ambiguous.ok && ambiguous.error.code, 'ambiguous_workspace')
  await again.deactivate()
})

test('issue requests run gh in the focused repo, and answer the repo error without one', async () => {
  const calls: { args: string[]; cwd?: string }[] = []
  const gh: Gh = async (args, options) => {
    calls.push({ args, cwd: options?.cwd })
    return ''
  }
  const worker = await mountWorker(listWorker(gh), { host: hostFocused({ branch: 'feature/spike', displayName: 'Spike' }) })
  assert.deepEqual(await worker.request('issue.comment', { number: 8, body: 'Fixed in #131.' }), { ok: true })
  assert.deepEqual(await worker.request('issue.close', { number: 8, reason: 'not planned' }), { ok: true })
  assert.deepEqual(calls.map((c) => [c.cwd, c.args.slice(0, 2)]), [
    ['/work/spike', ['issue', 'comment']],
    ['/work/spike', ['issue', 'close']]
  ])
  // A refused write is an answer too.
  const empty = await worker.request('issue.comment', { number: 8, body: ' ' })
  assert.equal(!empty.ok && empty.error.code, 'gh_failed')
  await worker.deactivate()

  const out = await mountWorker(listWorker(noGh), { host: hostFocused({ branch: 'main', displayName: 'out' }) })
  const answer = await out.request('issue.get', { number: 8 })
  assert.equal(!answer.ok && answer.error.code, 'gh_logged_out')
  await out.deactivate()
})

test('pull request requests run gh pr in the focused repo, and answer the repo error without one', async () => {
  const calls: { args: string[]; cwd?: string }[] = []
  const gh: Gh = async (args, options) => {
    calls.push({ args, cwd: options?.cwd })
    return args[0] === 'api' ? { data: { repository: { pullRequest: null } } } : ''
  }
  const worker = await mountWorker(listWorker(gh), { host: hostFocused({ branch: 'feature/spike', displayName: 'Spike' }) })
  assert.deepEqual(await worker.request('pull.comment', { number: 13, body: 'Looks good.' }), { ok: true })
  assert.deepEqual(await worker.request('pull.review', { number: 13, event: 'approve', body: '' }), { ok: true })
  assert.deepEqual(await worker.request('pull.edit', { number: 13, addLabels: ['bug'] }), { ok: true })
  const missing = await worker.request('pull.get', { number: 13 })
  assert.equal(!missing.ok && missing.error.code, 'not_found')
  const page = await worker.request('pull.timeline', { number: 13, after: 'c1' })
  assert.equal(!page.ok && page.error.code, 'not_found')
  assert.deepEqual(calls.map((c) => [c.cwd, c.args.slice(0, 2)]), [
    ['/work/spike', ['pr', 'comment']],
    ['/work/spike', ['pr', 'review']],
    ['/work/spike', ['pr', 'edit']],
    ['/work/spike', ['api', 'graphql']],
    ['/work/spike', ['api', 'graphql']]
  ])
  const empty = await worker.request('pull.review', { number: 13, event: 'request_changes', body: '' })
  assert.equal(!empty.ok && empty.error.code, 'gh_failed')
  await worker.deactivate()

  const out = await mountWorker(listWorker(noGh), { host: hostFocused({ branch: 'main', displayName: 'out' }) })
  const answer = await out.request('pull.get', { number: 13 })
  assert.equal(!answer.ok && answer.error.code, 'gh_logged_out')
  await out.deactivate()
})

test('repo.links answers what Orca links to the workspace, only for its own repo', async () => {
  let project: string | null = 'github:Octo/App'
  const module = {
    default: (orca: OrcaWorkerApi) =>
      main.activateWith(orca, {
        gh: noGh,
        ghRepo: async (path) => repos[path],
        terminalPath: async () => null,
        exists: () => true,
        links: async (path) => (path === '/work/spike' ? { project, issue: 4, pull: 13 } : null)
      })
  }
  const worker = await mountWorker(module, { host: hostFocused({ branch: 'feature/spike', displayName: 'Spike' }) })
  assert.deepEqual(await worker.request('repo.links'), { ok: true, issue: 4, pull: 13 })
  // A link Orca keeps for another repo (a workspace of a fork, say) is not this repo's issue 4.
  project = 'github:octo/fork'
  assert.deepEqual(await worker.request('repo.links'), { ok: true, issue: null, pull: null })
  project = null
  assert.deepEqual(await worker.request('repo.links'), { ok: true, issue: null, pull: null })
  await worker.deactivate()
})

test('repo.links: with no linked pull request, the branch pull request gh finds stands in', async () => {
  let branch: unknown = { number: 21 }
  const calls: { args: string[]; cwd?: string }[] = []
  const gh: Gh = async (args, options) => {
    calls.push({ args, cwd: options?.cwd })
    if (branch instanceof Error) throw branch
    return branch
  }
  let linked: { project: string | null; issue: number | null; pull: number | null } | null = { project: 'github:octo/app', issue: 4, pull: 13 }
  const module = {
    default: (orca: OrcaWorkerApi) =>
      main.activateWith(orca, { gh, ghRepo: async (path) => repos[path], terminalPath: async () => null, exists: () => true, links: async () => linked })
  }
  const worker = await mountWorker(module, { host: hostFocused({ branch: 'feature/spike', displayName: 'Spike' }) })
  // A linked pull request wins, and gh is not asked.
  assert.deepEqual(await worker.request('repo.links'), { ok: true, issue: 4, pull: 13 })
  assert.equal(calls.length, 0)
  assert.deepEqual(await worker.request('repo.links', { branch: true }), { ok: true, issue: 4, pull: 13 })
  assert.equal(calls.length, 0)
  linked = { project: 'github:octo/app', issue: 4, pull: null }
  // Only the Pull requests tab asks for the branch's: the Issues tab never pays a gh call.
  assert.deepEqual(await worker.request('repo.links'), { ok: true, issue: 4, pull: null })
  assert.deepEqual(await worker.request('repo.links', {}), { ok: true, issue: 4, pull: null })
  assert.equal(calls.length, 0)
  assert.deepEqual(await worker.request('repo.links', { branch: true }), { ok: true, issue: 4, pull: 21 })
  assert.deepEqual(calls[0], { args: ['pr', 'view', '--json', 'number'], cwd: '/work/spike' })
  // Orca's CLI says nothing: gh still finds the branch's.
  linked = null
  assert.deepEqual(await worker.request('repo.links', { branch: true }), { ok: true, issue: null, pull: 21 })
  // No pull request for the branch, or gh failing, is none, not an error.
  branch = new GhError('gh_failed', 'no pull requests found for branch "feature/spike"')
  assert.deepEqual(await worker.request('repo.links', { branch: true }), { ok: true, issue: null, pull: null })
  branch = { message: 'odd' }
  assert.deepEqual(await worker.request('repo.links', { branch: true }), { ok: true, issue: null, pull: null })
  await worker.deactivate()
})

test('orca.show runs the Tasks page or the Checks tab of Orca, and a refusal is an answer', async () => {
  const host = mockHost({
    results: {
      'workspace.readContext': { branch: 'feature/spike', displayName: 'Spike', terminals: [] },
      'workspace.list': { workspaces, truncated: false },
      'commands.run': { ran: true }
    }
  })
  const worker = await mountWorker(listWorker(noGh), { host })
  assert.deepEqual(await worker.request('orca.show', { view: 'tasks' }), { ok: true })
  assert.deepEqual(await worker.request('orca.show', { view: 'checks' }), { ok: true })
  assert.deepEqual(host.callsOf('commands.run'), [{ action: 'view.tasks' }, { action: 'sidebar.checks.toggle' }])
  const odd = await worker.request('orca.show', { view: 'board' as never })
  assert.equal(!odd.ok && odd.error.code, 'gh_failed')
  await worker.deactivate()

  const refusing = mockHost({
    results: {
      'workspace.readContext': { branch: 'feature/spike', displayName: 'Spike', terminals: [] },
      'workspace.list': { workspaces, truncated: false },
      'commands.run': () => Promise.reject(hostError('unavailable', 'Not the desktop app'))
    }
  })
  const web = await mountWorker(listWorker(noGh), { host: refusing })
  const answer = await web.request('orca.show', { view: 'tasks' })
  assert.deepEqual(answer, { ok: false, error: { code: 'host_failed', message: 'Not the desktop app' } })
  await web.deactivate()
})

function runWorker(gh: Gh, branch: string | null = 'feature/spike') {
  let t = 0
  return {
    default: (orca: OrcaWorkerApi) =>
      main.activateWith(orca, {
        gh,
        ghRepo: async (path) => repos[path],
        terminalPath: async () => null,
        exists: () => true,
        branch: async () => branch,
        watch: { now: () => t, sleep: async (ms) => void (t += ms) }
      })
  }
}

test('run.watch posts each poll to the panel that asked, and answers done when the run ends', async () => {
  let polls = 0
  const gh: Gh = async (args) => {
    if (args.some((a) => a.includes('/jobs'))) return [{ jobs: [] }]
    polls++
    return { id: 9, name: 'CI', display_title: 'CI', run_number: 1, event: 'push', status: polls < 3 ? 'in_progress' : 'completed', conclusion: polls < 3 ? null : 'success', head_branch: 'main', head_sha: 'abc1234', actor: null, run_started_at: '2026-11-13T06:40:00Z', updated_at: '2026-11-13T06:41:00Z', html_url: 'https://github.com/octo/app/actions/runs/9' }
  }
  const worker = await mountWorker(runWorker(gh), { host: hostFocused({ branch: 'feature/spike', displayName: 'Spike' }) })
  const watched = await worker.request('run.watch', { id: 9 })
  assert.equal(watched.ok && watched.done, true)
  const progress = worker.posts.filter((p) => p.event === 'run.progress')
  assert.equal(progress.length, 3)
  assert.ok(progress.every((p) => typeof p.panel === 'string' && p.panel.length > 0))
  assert.deepEqual(progress.map((p) => (p.payload as { run: { done: boolean } }).run.done), [false, false, true])
  await worker.deactivate()
})

test('workflow.form reads the workflow at the workspace branch, and run writes run gh in the repo', async () => {
  const calls: string[][] = []
  const gh: Gh = async (args) => {
    calls.push(args)
    if (args[0] === 'workflow' && args[1] === 'view') return 'on: workflow_dispatch\n'
    return args[0] === 'api' ? { name: 'feature/spike' } : ''
  }
  const worker = await mountWorker(runWorker(gh), { host: hostFocused({ branch: 'feature/spike', displayName: 'Spike' }) })
  assert.deepEqual(await worker.request('workflow.form', { workflow: 77 }), { ok: true, form: { ref: 'feature/spike', dispatch: true, inputs: [] } })
  assert.deepEqual(await worker.request('workflow.run', { workflow: 77, ref: 'feature/spike', inputs: {} }), { ok: true, run: null })
  assert.deepEqual(await worker.request('run.rerun', { id: 9, failed: true }), { ok: true })
  assert.deepEqual(await worker.request('run.cancel', { id: 9 }), { ok: true })
  assert.deepEqual(calls.map((a) => a.slice(0, 2)), [
    ['api', 'repos/octo/app/branches/feature%2Fspike'],
    ['workflow', 'view'],
    ['workflow', 'run'],
    // Looking for the run it started: GitHub shows none here.
    ...Array.from({ length: 5 }, () => ['api', '-X']),
    ['run', 'rerun'],
    ['run', 'cancel']
  ])
  await worker.deactivate()
})
