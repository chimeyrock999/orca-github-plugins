// The list fetchers over a fake gh: the gh arguments they build and the rows they map.
import { assert, test } from 'orca/testing'
import { GhError, type Gh } from './gh'
import { itemSearch, listIssues, listLabels, listPulls, listRuns, listWorkflows, parseRunQuery } from './lists'

const repo = { nameWithOwner: 'octo/app', path: '/code/app' }

function fakeGh(...answers: unknown[]): Gh & { calls: { args: string[]; cwd?: string }[] } {
  const calls: { args: string[]; cwd?: string }[] = []
  const gh: Gh = async (args, options) => {
    calls.push({ args, cwd: options?.cwd })
    const next = answers.shift()
    if (next instanceof Error) throw next
    return next
  }
  return Object.assign(gh, { calls })
}

/** The value passed for `-f name=` or `-F name=` in a gh api call. */
function field(args: string[], name: string): string | undefined {
  const i = args.findIndex((a, k) => (args[k - 1] === '-f' || args[k - 1] === '-F') && a.startsWith(`${name}=`))
  return i < 0 ? undefined : args[i].slice(name.length + 1)
}

const issueNode = {
  __typename: 'Issue',
  number: 8,
  title: 'Docs, manifest and visual polish',
  url: 'https://github.com/octo/app/issues/8',
  state: 'OPEN',
  stateReason: null,
  createdAt: '2026-11-12T11:40:37Z',
  closedAt: null,
  author: { login: 'mai-t' },
  labels: { nodes: [{ name: 'documentation' }] }
}

function searchAnswer(nodes: unknown[], more = false, count = 72) {
  return {
    data: {
      page: { issueCount: count, pageInfo: { hasNextPage: more, endCursor: more ? 'Y3Vyc29yOjMw' : null }, nodes },
      open: { issueCount: 72 },
      closed: { issueCount: 5 }
    }
  }
}

test('itemSearch builds the repo, kind and state qualifiers, newest first, then the words', () => {
  assert.equal(itemSearch(repo, 'issue', 'open', '  csv export '), 'repo:octo/app is:issue is:open sort:created-desc csv export')
  assert.equal(itemSearch(repo, 'pr', 'closed', ''), 'repo:octo/app is:pr is:closed sort:created-desc')
})

test('itemSearch: all leaves the state out, assignee is a qualifier quoted like the others', () => {
  assert.equal(itemSearch(repo, 'issue', 'all', ''), 'repo:octo/app is:issue sort:created-desc')
  assert.equal(
    itemSearch(repo, 'issue', 'all', 'csv', { assignee: '@me', label: 'needs review' }),
    'repo:octo/app is:issue label:"needs review" assignee:@me sort:created-desc csv'
  )
})

test('issues: all still counts open and closed apart', async () => {
  const gh = fakeGh(searchAnswer([issueNode]))
  const page = await listIssues(gh, repo, { state: 'all', query: '', after: null, filters: { assignee: 'kenji' } })
  const { args } = gh.calls[0]
  assert.equal(field(args, 'q'), 'repo:octo/app is:issue assignee:kenji sort:created-desc')
  assert.equal(field(args, 'openQ'), 'repo:octo/app is:issue is:open assignee:kenji')
  assert.equal(field(args, 'closedQ'), 'repo:octo/app is:issue is:closed assignee:kenji')
  assert.equal(page.open, 72)
})

test('issues: one GraphQL search in the repo folder, with both counts and the page cursor', async () => {
  const gh = fakeGh(searchAnswer([issueNode], true))
  const page = await listIssues(gh, repo, { state: 'open', query: 'csv', after: 'Y3Vyc29yOjA=' })
  const { args, cwd } = gh.calls[0]
  assert.equal(cwd, '/code/app')
  assert.deepEqual(args.slice(0, 2), ['api', 'graphql'])
  assert.equal(field(args, 'q'), 'repo:octo/app is:issue is:open sort:created-desc csv')
  assert.equal(field(args, 'openQ'), 'repo:octo/app is:issue is:open csv')
  assert.equal(field(args, 'closedQ'), 'repo:octo/app is:issue is:closed csv')
  assert.equal(field(args, 'first'), '30')
  assert.equal(field(args, 'after'), 'Y3Vyc29yOjA=')
  assert.deepEqual(page, {
    rows: [
      {
        number: 8,
        title: 'Docs, manifest and visual polish',
        url: 'https://github.com/octo/app/issues/8',
        state: 'open',
        author: 'mai-t',
        labels: ['documentation'],
        createdAt: Date.parse('2026-11-12T11:40:37Z'),
        closedAt: null
      }
    ],
    total: 72,
    open: 72,
    closed: 5,
    next: 'Y3Vyc29yOjMw',
    limit: 1000
  })
})

test('the first page sends no cursor, and the last page has no next', async () => {
  const gh = fakeGh(searchAnswer([issueNode]))
  const page = await listIssues(gh, repo, { state: 'open', query: '', after: null })
  assert.equal(field(gh.calls[0].args, 'after'), undefined)
  assert.equal(page.next, null)
})

test('closed issues: done or not planned by state reason; a deleted author is null', async () => {
  const closed = { ...issueNode, state: 'CLOSED', closedAt: '2026-11-13T00:00:00Z', author: null }
  const gh = fakeGh(
    searchAnswer([
      { ...closed, number: 1, stateReason: 'COMPLETED' },
      { ...closed, number: 2, stateReason: 'NOT_PLANNED' },
      { ...closed, number: 3, stateReason: 'DUPLICATE' },
      { ...closed, number: 4, stateReason: null }
    ], false, 5)
  )
  const page = await listIssues(gh, repo, { state: 'closed', query: '', after: null })
  assert.deepEqual(page.rows.map((r) => r.state), ['done', 'not_planned', 'not_planned', 'done'])
  assert.equal(page.rows[0].author, null)
  assert.equal(page.rows[0].closedAt, Date.parse('2026-11-13T00:00:00Z'))
  assert.equal(page.total, 5)
})

test('pull requests: open, draft, merged and closed, with the branch', async () => {
  const pr = { ...issueNode, __typename: 'PullRequest', headRefName: 'fix/token', isDraft: false, merged: false, mergedAt: null }
  const gh = fakeGh(
    searchAnswer([
      { ...pr, number: 1 },
      { ...pr, number: 2, isDraft: true },
      { ...pr, number: 3, state: 'MERGED', merged: true, mergedAt: '2026-11-13T00:00:00Z', closedAt: '2026-11-13T00:00:00Z' },
      { ...pr, number: 4, state: 'CLOSED', closedAt: '2026-11-13T00:00:00Z' },
      issueNode
    ])
  )
  const page = await listPulls(gh, repo, { state: 'open', query: '', after: null })
  assert.equal(field(gh.calls[0].args, 'q'), 'repo:octo/app is:pr is:open sort:created-desc')
  assert.deepEqual(page.rows.map((r) => [r.number, r.state, r.branch]), [
    [1, 'open', 'fix/token'],
    [2, 'draft', 'fix/token'],
    [3, 'merged', 'fix/token'],
    [4, 'closed', 'fix/token']
  ])
  assert.equal(page.rows[2].mergedAt, Date.parse('2026-11-13T00:00:00Z'))
})

test('a GraphQL answer without data is gh_failed', async () => {
  await assert.rejects(listIssues(fakeGh({ errors: [{ message: 'boom' }] }), repo, { state: 'open', query: '', after: null }), (e) => {
    return e instanceof GhError && e.code === 'gh_failed' && /boom/.test(e.message)
  })
})

test('parseRunQuery maps qualifiers to the runs API and refuses plain words', () => {
  assert.deepEqual(parseRunQuery('  branch:dev status:failure actor:mai-t event:push workflow:CI '), {
    params: { branch: 'dev', status: 'failure', actor: 'mai-t', event: 'push' },
    workflow: 'CI'
  })
  assert.deepEqual(parseRunQuery(''), { params: {}, workflow: null })
  assert.throws(() => parseRunQuery('csv export'), (e: unknown) => e instanceof GhError && e.code === 'bad_query')
  assert.throws(() => parseRunQuery('label:bug'), (e: unknown) => e instanceof GhError && e.code === 'bad_query')
  assert.throws(() => parseRunQuery('branch:'), (e: unknown) => e instanceof GhError && e.code === 'bad_query')
  // Quoted values keep their spaces; qualifier names take any case.
  assert.deepEqual(parseRunQuery('Workflow:"CI build" BRANCH:dev'), { params: { branch: 'dev' }, workflow: 'CI build' })
})

const runJson = {
  id: 43220405418,
  name: 'CI',
  display_title: 'Fix token refresh loop',
  run_number: 296,
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  head_branch: 'main',
  head_sha: '233b470d3a189e89cf6fa69624e11c3fa9387d81',
  actor: { login: 'mai-t' },
  run_started_at: '2026-11-12T12:42:42Z',
  updated_at: '2026-11-12T12:50:28Z',
  html_url: 'https://github.com/octo/app/actions/runs/43220405418',
  pull_requests: []
}

test('runs: one REST page with the qualifiers as parameters, and the next page number', async () => {
  const gh = fakeGh({ total_count: 296, workflow_runs: [runJson] })
  const page = await listRuns(gh, repo, { query: 'branch:main status:success', after: '2' })
  const { args, cwd } = gh.calls[0]
  assert.equal(cwd, '/code/app')
  assert.deepEqual(args.slice(0, 4), ['api', '-X', 'GET', 'repos/octo/app/actions/runs'])
  assert.equal(field(args, 'per_page'), '30')
  assert.equal(field(args, 'page'), '2')
  assert.equal(field(args, 'branch'), 'main')
  assert.equal(field(args, 'status'), 'success')
  assert.deepEqual(page.rows[0], {
    id: 43220405418,
    runNumber: 296,
    workflow: 'CI',
    title: 'Fix token refresh loop',
    url: 'https://github.com/octo/app/actions/runs/43220405418',
    state: 'success',
    event: 'push',
    branch: 'main',
    sha: '233b470d3a189e89cf6fa69624e11c3fa9387d81',
    actor: 'mai-t',
    pullNumber: null,
    startedAt: Date.parse('2026-11-12T12:42:42Z'),
    durationMs: 466_000
  })
  assert.equal(page.total, 296)
  assert.equal(page.next, '3')
  // A filtered runs list stops at 1,000, like search.
  assert.equal(page.limit, 1000)
})

test('runs: the last page has no next, and a bad cursor reads as page 1', async () => {
  const gh = fakeGh({ total_count: 31, workflow_runs: [] }, { total_count: 31, workflow_runs: [] })
  assert.equal((await listRuns(gh, repo, { query: '', after: '2' })).next, null)
  assert.equal((await listRuns(gh, repo, { query: '', after: 'x' })).next, '2')
  assert.equal(field(gh.calls[1].args, 'page'), '1')
})

test('run states: queued and in progress run, failures fail, approval waits, skipped is not cancelled', async () => {
  const states = [
    ['queued', null],
    ['in_progress', null],
    ['completed', 'failure'],
    ['completed', 'timed_out'],
    ['completed', 'startup_failure'],
    ['completed', 'cancelled'],
    ['completed', 'skipped'],
    ['completed', 'neutral'],
    ['completed', 'action_required'],
    ['waiting', null]
  ]
  const runs = states.map(([status, conclusion], i) => ({ ...runJson, id: i, status, conclusion }))
  const page = await listRuns(fakeGh({ total_count: runs.length, workflow_runs: runs }), repo, { query: '', after: null })
  assert.deepEqual(page.rows.map((r) => r.state), [
    'running',
    'running',
    'failure',
    'failure',
    'failure',
    'cancelled',
    'skipped',
    'skipped',
    'waiting',
    'waiting'
  ])
  assert.equal(page.rows[0].durationMs, null)
})

test('a pull request run names its pull request', async () => {
  const run = { ...runJson, event: 'pull_request', pull_requests: [{ number: 134 }] }
  const page = await listRuns(fakeGh({ total_count: 1, workflow_runs: [run] }), repo, { query: '', after: null })
  assert.equal(page.rows[0].pullNumber, 134)
})

test('workflow: a file name goes straight to its runs; a name is looked up first', async () => {
  const byFile = fakeGh({ total_count: 0, workflow_runs: [] })
  await listRuns(byFile, repo, { query: 'workflow:ci.yml', after: null })
  assert.equal(byFile.calls[0].args[3], 'repos/octo/app/actions/workflows/ci.yml/runs')

  const byId = fakeGh({ total_count: 0, workflow_runs: [] })
  await listRuns(byId, repo, { query: '', after: null, filters: { workflow: '9' } })
  assert.equal(byId.calls.length, 1)
  assert.equal(byId.calls[0].args[3], 'repos/octo/app/actions/workflows/9/runs')

  // Every page of workflows is read, so the 101st is found too.
  const byName = fakeGh([{ workflows: [{ id: 7, name: 'Release' }] }, { workflows: [{ id: 9, name: 'CI build' }] }], { total_count: 0, workflow_runs: [] })
  await listRuns(byName, repo, { query: 'Workflow:"ci build"', after: null })
  assert.deepEqual(byName.calls[0].args, ['api', '--paginate', '--slurp', 'repos/octo/app/actions/workflows?per_page=100'])
  assert.equal(byName.calls[1].args[3], 'repos/octo/app/actions/workflows/9/runs')
})

test('workflow: an unknown name is not_found', async () => {
  await assert.rejects(listRuns(fakeGh([{ workflows: [] }]), repo, { query: 'workflow:nope', after: null }), (e) => {
    return e instanceof GhError && e.code === 'not_found'
  })
})

test('filters and order go into the search; the counts keep the filters but not the order', async () => {
  assert.equal(
    itemSearch(repo, 'issue', 'open', 'csv', { author: 'mai-t', label: 'good first issue' }, 'comments-desc'),
    'repo:octo/app is:issue is:open author:mai-t label:"good first issue" sort:comments-desc csv'
  )
  const gh = fakeGh(searchAnswer([issueNode]))
  await listIssues(gh, repo, { state: 'open', query: '', after: null, filters: { label: 'bug', author: ' ' }, sort: 'created-asc' })
  assert.equal(field(gh.calls[0].args, 'q'), 'repo:octo/app is:issue is:open label:bug sort:created-asc')
  assert.equal(field(gh.calls[0].args, 'closedQ'), 'repo:octo/app is:issue is:closed label:bug')
})

test('run filters become parameters and win over the same qualifier in the search', async () => {
  const gh = fakeGh({ total_count: 0, workflow_runs: [] })
  await listRuns(gh, repo, { query: 'branch:main status:success', after: null, filters: { status: 'failure', event: 'push', workflow: '9', branch: '' } })
  const { args } = gh.calls[0]
  assert.equal(args[3], 'repos/octo/app/actions/workflows/9/runs')
  assert.equal(field(args, 'branch'), 'main')
  assert.equal(field(args, 'status'), 'failure')
  assert.equal(field(args, 'event'), 'push')
})

test('labels and workflows list their names', async () => {
  const labels = fakeGh([{ name: 'enhancement' }, { name: 'bug' }])
  assert.deepEqual(await listLabels(labels, repo), { names: ['bug', 'enhancement'] })
  assert.equal(labels.calls[0].cwd, '/code/app')
  assert.deepEqual(labels.calls[0].args, ['label', 'list', '--json', 'name', '--limit', '500'])
  const pages = [{ total_count: 2, workflows: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml' }] }, { workflows: [{ id: 2, name: 'Release' }] }]
  assert.deepEqual(await listWorkflows(fakeGh(pages), repo), { workflows: [{ id: 1, name: 'CI' }, { id: 2, name: 'Release' }] })
})

test('runs: no filter reaches every run; a filter stops the pages at 1,000', async () => {
  const all = await listRuns(fakeGh({ total_count: 5000, workflow_runs: [] }), repo, { query: '', after: '40' })
  assert.deepEqual([all.limit, all.next], [null, '41'])
  const filtered = await listRuns(fakeGh({ total_count: 5000, workflow_runs: [] }), repo, { query: 'status:success', after: '34' })
  assert.deepEqual([filtered.limit, filtered.next], [1000, null])
})

test('paging asks for no counts: the open and closed counts come back null', async () => {
  const gh = fakeGh({ data: { page: { issueCount: 72, pageInfo: { hasNextPage: true, endCursor: 'c' }, nodes: [] } } })
  const page = await listIssues(gh, repo, { state: 'open', query: '', after: 'c0', withCounts: false })
  assert.equal(field(gh.calls[0].args, 'withCounts'), 'false')
  assert.deepEqual([page.open, page.closed, page.total], [null, null, 72])
})
