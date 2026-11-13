// How many gh calls the panel's screens cost, through the real worker over a fake GitHub that
// answers conditional reads as GitHub does (a 304 when nothing changed, which costs no budget).
// Each scenario is the requests the panel sends for that screen; the counts are the PR's numbers.
import { assert, mountWorker, mockHost, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import * as main from '../src/worker'
import { Conditional, GhError, type Gh, type GhOptions } from '../src/worker/gh'
import type { RateLimit } from '../src/worker/gh'
import { repos, workspaces } from './fixtures/worker-fixtures'

const NOW = Date.parse('2026-11-13T07:00:00Z')

const issueNode = (n: number) => ({
  __typename: 'Issue',
  number: n,
  title: `Issue ${n}`,
  url: `https://github.com/octo/app/issues/${n}`,
  state: 'OPEN',
  updatedAt: '2026-11-13T06:00:00Z',
  author: { login: 'ana' }
})

const issueAnswer = (body: string) => ({
  data: {
    repository: {
      issue: {
        id: 'I_8',
        number: 8,
        title: 'Export CSV drops rows past 10k',
        url: 'https://github.com/octo/app/issues/8',
        state: 'OPEN',
        stateReason: null,
        body,
        createdAt: '2026-11-10T09:00:00Z',
        closedAt: null,
        viewerCanUpdate: true,
        author: { login: 'mai-t' },
        labels: { nodes: [] },
        assignees: { nodes: [] },
        milestone: null,
        comments: { totalCount: 0 },
        reactionGroups: [],
        head: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, edges: [] },
        tail: { edges: [] }
      }
    },
    viewer: { login: 'ana' }
  }
})

const runJson = { id: 9, name: 'CI', display_title: 'CI', run_number: 1, event: 'push', status: 'in_progress', conclusion: null, head_branch: 'main', head_sha: 'abc1234', actor: null, run_started_at: '2026-11-13T06:40:00Z', updated_at: '2026-11-13T06:41:00Z', html_url: 'https://github.com/octo/app/actions/runs/9' }
const jobsJson = { total_count: 1, jobs: [{ id: 1, name: 'test', html_url: 'https://github.com/octo/app/actions/runs/9/job/1', status: 'in_progress', conclusion: null, started_at: '2026-11-13T06:40:00Z', completed_at: null, steps: [] }] }

/** A fake GitHub: what each call answers, every call it got, and how many counted against the
 *  budget (all but 304s). `edit` changes what the issue body reads, as a write would. */
function github() {
  const calls: string[] = []
  let spent = 0
  let body = 'Before the write.'
  let version = 1
  const rate = (): RateLimit => ({ resource: 'core', limit: 5_000, remaining: 4_000 - spent, resetAt: NOW + 3_600_000 })
  function answer(args: string[]): unknown {
    const text = args.join(' ')
    if (args[0] === 'api' && args[1] === 'graphql') return text.includes('issueOrPullRequest') ? { data: { r0: { n8: issueNode(8), n9: issueNode(9) } } } : issueAnswer(body)
    if (text.includes('-X POST')) {
      body = 'After the write.'
      version++
      return JSON.stringify({ id: 1, node_id: 'IC_1', html_url: 'https://github.com/octo/app/issues/8#issuecomment-1', body: 'Done.', user: { login: 'ana' }, created_at: '2026-11-13T07:00:00Z' })
    }
    if (args[0] === 'pr') return { number: 21 }
    if (args[0] === 'label') return [{ name: 'bug' }]
    if (args[1]?.endsWith('/jobs?filter=latest&per_page=100')) return jobsJson
    if (args[1]?.endsWith('/actions/runs/9')) return runJson
    return ''
  }
  const gh: Gh = async (args: string[], options: GhOptions = {}) => {
    calls.push(args.slice(0, 2).join(' '))
    if (options.etag !== undefined) {
      const etag = `W/"${args[1]}#${version}"`
      if (options.etag === etag) return new Conditional(304, etag, null, rate())
      spent++
      return new Conditional(200, etag, answer(args), rate())
    }
    spent++
    return answer(args)
  }
  return { gh, calls, spent: () => spent }
}

function mount(gh: Gh) {
  let t = 0
  let links = { project: 'github:octo/app', items: [8, 9].map((n) => ({ provider: 'github', type: 'issue', number: n, url: `https://github.com/octo/app/issues/${n}` })) }
  let context = { branch: 'feature/spike', displayName: 'Spike', terminals: [] as { id: string }[] }
  const host = mockHost({ results: { 'workspace.readContext': () => context, 'workspace.list': { workspaces, truncated: false } } })
  const module = {
    default: (orca: OrcaWorkerApi) =>
      main.activateWith(orca, {
        gh,
        ghRepo: async (path) => (path === '/code/lib' ? { ok: true, nameWithOwner: 'octo/lib', url: 'https://github.com/octo/lib' } : repos[path]),
        terminalPath: async (id) => (id === 'app' ? '/code/app' : id === 'lib' ? '/code/lib' : null),
        exists: () => true,
        links: async () => links as never,
        branch: async () => 'feature/spike',
        now: () => NOW,
        watch: { now: () => t, sleep: async (ms) => void (t += ms) }
      })
  }
  return mountWorker(module, { host }).then((worker) => ({
    worker,
    /** Moves Orca's focus to another workspace of the same repo, or back. */
    focus: (to: 'app' | 'spike') => {
      context = to === 'app' ? { branch: 'main', displayName: 'main', terminals: [{ id: 'app' }] } : { branch: 'feature/spike', displayName: 'Spike', terminals: [] }
      return worker.emit('workspace.changed', { context })
    },
    unlink: () => (links = { project: 'github:octo/app', items: [] })
  }))
}

const items = [8, 9].map((number) => ({ number, repo: null, title: null, url: null }))

test('the screens the panel shows cost fewer gh calls, and a write or Refresh still asks GitHub', async () => {
  const hub = github()
  const { worker, focus } = await mount(hub.gh)
  const cost = async (step: () => Promise<unknown>) => {
    const before = hub.calls.length
    await step()
    return hub.calls.length - before
  }
  const list = () => Promise.all([worker.request('repo.links'), worker.request('items.get', { kind: 'issues', items })])
  const open = () => worker.request('issue.get', { number: 8 })

  // Open the Issues tab (two linked issues: the list), open one, go Back.
  assert.equal(await cost(list), 1)
  assert.equal(await cost(open), 1)
  assert.equal(await cost(list), 0)
  // Another workspace of the same repo and back: nothing is asked again within the TTL.
  await focus('app')
  assert.equal(await cost(list), 0)
  await focus('spike')
  assert.equal(await cost(async () => (await list(), await open())), 0)
  // Refresh asks GitHub again.
  assert.equal(await cost(async () => (await worker.request('cache.drop'), await list(), await open())), 2)
  // A comment is one call: the panel shows the comment GitHub answers instead of asking again.
  const commented = await worker.request('issue.comment', { number: 8, body: 'Done.' })
  assert.equal(commented.ok && commented.comment?.body, 'Done.')
  // A write never leaves the state before it: the thread and the list are asked for again.
  const after = await open()
  assert.equal(after.ok && after.issue.body, 'After the write.')
  assert.equal(await cost(list), 1)
  // The Pull requests tab with no linked pull request asks gh for the branch's once.
  const pulls = () => worker.request('repo.links', { branch: true })
  assert.equal(await cost(pulls), 1)
  assert.equal(await cost(pulls), 0)
  // A run still going is read each time it opens (the run and its jobs).
  assert.equal(await cost(() => worker.request('run.get', { id: 9 })), 2)
  // Labels are kept across workspaces of the same repo.
  assert.equal(await cost(() => worker.request('labels.list', {})), 1)
  await focus('app')
  assert.equal(await cost(() => worker.request('labels.list', {})), 0)
  await worker.deactivate()
})

test("a run write drops the repo's items too: a pull request's checks change with it", async () => {
  const hub = github()
  const { worker } = await mount(hub.gh)
  await worker.request('issue.get', { number: 8 })
  await worker.request('run.rerun', { id: 9, failed: true })
  const before = hub.calls.length
  await worker.request('issue.get', { number: 8 })
  assert.equal(hub.calls.length - before, 1)
  await worker.deactivate()
})

test('a run watched through a lease while it does not change costs no budget: every poll is a 304', async () => {
  const hub = github()
  const { worker } = await mount(hub.gh)
  await worker.request('run.get', { id: 9 })
  const spentBefore = hub.spent()
  const watched = await worker.request('run.watch', { id: 9 })
  assert.equal(watched.ok && watched.done, false)
  const polls = worker.posts.filter((p) => p.event === 'run.progress').length
  assert.ok(polls >= 3, `polls: ${polls}`)
  // Each poll is a conditional read of the run and its jobs: two calls, both 304.
  assert.equal(hub.spent() - spentBefore, 0)
  await worker.deactivate()
})

test('a repo the workspace no longer shows keeps nothing', async () => {
  const hub = github()
  const { worker } = await mount(hub.gh)
  await worker.request('issue.get', { number: 8 })
  assert.deepEqual(await worker.request('budget.get'), { ok: true, budget: null })
  // A folder with no GitHub repo keeps it; another repo drops it.
  await worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'gl', terminals: [] } })
  await worker.emit('workspace.changed', { context: { branch: 'feature/spike', displayName: 'Spike', terminals: [] } })
  let before = hub.calls.length
  await worker.request('issue.get', { number: 8 })
  assert.equal(hub.calls.length - before, 0)
  await worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'lib', terminals: [{ id: 'lib' }] } })
  await worker.emit('workspace.changed', { context: { branch: 'feature/spike', displayName: 'Spike', terminals: [] } })
  before = hub.calls.length
  await worker.request('issue.get', { number: 8 })
  assert.equal(hub.calls.length - before, 1)
  await worker.deactivate()
})

test('a low budget is told to the panels and kept answers live longer', async () => {
  let remaining = 300
  const gh: Gh = async (args, options = {}) =>
    options.etag !== undefined
      ? new Conditional(200, null, args[1]?.includes('/jobs') ? jobsJson : runJson, { resource: 'core', limit: 5_000, remaining, resetAt: NOW + 600_000 })
      : ''
  const { worker } = await mount(gh)
  await worker.request('run.get', { id: 9 })
  assert.deepEqual(await worker.request('budget.get'), { ok: true, budget: { limit: 5_000, remaining: 300, resetAt: NOW + 600_000 } })
  const told = worker.posts.filter((p) => p.event === 'budget.changed').map((p) => p.payload)
  assert.deepEqual(told, [{ budget: { limit: 5_000, remaining: 300, resetAt: NOW + 600_000 } }])
  remaining = 4_000
  await worker.request('cache.drop')
  await worker.request('run.get', { id: 9 })
  assert.deepEqual(await worker.request('budget.get'), { ok: true, budget: null })
  assert.deepEqual(worker.posts.filter((p) => p.event === 'budget.changed').at(-1)?.payload, { budget: null })
  await worker.deactivate()
})

test('a run still going is not kept, so reopening it never goes back; a finished one is', async () => {
  let status = 'in_progress'
  let reads = 0
  const gh: Gh = async (args) => {
    if (args[1]?.endsWith('/actions/runs/9')) reads++
    return args[1]?.includes('/jobs') ? jobsJson : { ...runJson, status, conclusion: status === 'completed' ? 'success' : null }
  }
  const { worker } = await mount(gh)
  await worker.request('run.get', { id: 9 })
  status = 'completed'
  const again = await worker.request('run.get', { id: 9 })
  assert.equal(again.ok && again.run.done, true)
  await worker.request('run.get', { id: 9 })
  assert.equal(reads, 2)
  await worker.deactivate()
})

test('a page of runs is a plain GET (a conditional read); a page with a run going is not kept', async () => {
  const asked: string[] = []
  let status = 'in_progress'
  const gh: Gh = async (args) => {
    asked.push(args.join(' '))
    return { total_count: 1, workflow_runs: [{ ...runJson, status, conclusion: status === 'completed' ? 'success' : null, created_at: runJson.run_started_at }] }
  }
  const { worker } = await mount(gh)
  const input = { query: '', after: null, scope: 'all' as const }
  await worker.request('runs.list', input)
  status = 'completed'
  await worker.request('runs.list', input)
  await worker.request('runs.list', input)
  assert.equal(asked.length, 2)
  assert.match(asked[0], /^api repos\/octo\/app\/actions\/runs\?per_page=\d+&page=1$/)
  await worker.deactivate()
})

test("the branch's pull request is kept when gh found it or found none, not when gh could not tell", async () => {
  let answer: unknown = new GhError('rate_limited', 'API rate limit exceeded')
  let asked = 0
  const gh: Gh = async () => {
    asked++
    if (answer instanceof Error) throw answer
    return answer
  }
  const { worker, unlink } = await mount(gh)
  unlink()
  assert.deepEqual(await worker.request('repo.links', { branch: true }), { ok: true, issues: [], pulls: [] })
  answer = { number: 21 }
  const found = await worker.request('repo.links', { branch: true })
  assert.equal(found.ok && found.pulls[0]?.number, 21)
  await worker.request('repo.links', { branch: true })
  assert.equal(asked, 2)
  await worker.deactivate()
})

test('a repo left through a folder with no repo keeps nothing once another repo shows', async () => {
  const hub = github()
  const { worker } = await mount(hub.gh)
  await worker.request('issue.get', { number: 8 })
  await worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'gl', terminals: [] } })
  await worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'lib', terminals: [{ id: 'lib' }] } })
  await worker.emit('workspace.changed', { context: { branch: 'feature/spike', displayName: 'Spike', terminals: [] } })
  const before = hub.calls.length
  await worker.request('issue.get', { number: 8 })
  assert.equal(hub.calls.length - before, 1)
  await worker.deactivate()
})
