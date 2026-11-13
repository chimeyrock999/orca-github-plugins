// The list fetchers over a fake gh: the gh arguments they build and the rows they map.
import { assert, test } from 'orca/testing'
import { GhError, type Gh } from '../../src/worker/gh'
import { issueState, listLabels, listRuns, listWorkflows, parseRunQuery, pullState } from '../../src/worker/lists'

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
/** A runs request's query parameter: the query is in the path, so the read is a plain GET. */
function field(args: string[], name: string): string | undefined {
  return new URLSearchParams(args[1]?.split('?')[1] ?? '').get(name) ?? undefined
}
const pathOf = (args: string[]) => args[1]?.split('?')[0]

test('issue and pull request states: done or not planned by state reason; merged and draft', () => {
  assert.equal(issueState({ state: 'OPEN' }), 'open')
  assert.equal(issueState({ state: 'CLOSED', stateReason: 'COMPLETED' }), 'done')
  assert.equal(issueState({ state: 'CLOSED', stateReason: 'NOT_PLANNED' }), 'not_planned')
  assert.equal(issueState({ state: 'CLOSED', stateReason: 'DUPLICATE' }), 'not_planned')
  assert.equal(pullState({ state: 'OPEN', isDraft: true }), 'draft')
  assert.equal(pullState({ state: 'MERGED', merged: true }), 'merged')
  assert.equal(pullState({ state: 'CLOSED' }), 'closed')
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
  assert.deepEqual([args.length, args[0], pathOf(args)], [2, 'api', 'repos/octo/app/actions/runs'])
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

test('run states: queued waits to start, in progress runs, failures fail, approval waits, skipped is not cancelled', async () => {
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
    'queued',
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
  assert.equal(pathOf(byFile.calls[0].args), 'repos/octo/app/actions/workflows/ci.yml/runs')

  const byId = fakeGh({ total_count: 0, workflow_runs: [] })
  await listRuns(byId, repo, { query: '', after: null, filters: { workflow: '9' } })
  assert.equal(byId.calls.length, 1)
  assert.equal(pathOf(byId.calls[0].args), 'repos/octo/app/actions/workflows/9/runs')

  // Every page of workflows is read, so the 101st is found too.
  const byName = fakeGh([{ workflows: [{ id: 7, name: 'Release' }] }, { workflows: [{ id: 9, name: 'CI build' }] }], { total_count: 0, workflow_runs: [] })
  await listRuns(byName, repo, { query: 'Workflow:"ci build"', after: null })
  assert.deepEqual(byName.calls[0].args, ['api', '--paginate', '--slurp', 'repos/octo/app/actions/workflows?per_page=100'])
  assert.equal(pathOf(byName.calls[1].args), 'repos/octo/app/actions/workflows/9/runs')
})

test('workflow: an unknown name is not_found', async () => {
  await assert.rejects(listRuns(fakeGh([{ workflows: [] }]), repo, { query: 'workflow:nope', after: null }), (e) => {
    return e instanceof GhError && e.code === 'not_found'
  })
})

test('run filters become parameters and win over the same qualifier in the search', async () => {
  const gh = fakeGh({ total_count: 0, workflow_runs: [] })
  await listRuns(gh, repo, { query: 'branch:main status:success', after: null, filters: { status: 'failure', event: 'push', workflow: '9', branch: '' } })
  const { args } = gh.calls[0]
  assert.equal(pathOf(args), 'repos/octo/app/actions/workflows/9/runs')
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

test('runs scoped to the branch narrow to the workspace branch unless a branch is asked for', async () => {
  const page = { total_count: 0, workflow_runs: [] }
  const gh = fakeGh(page, page, page, page)
  assert.equal((await listRuns(gh, repo, { query: '', after: null, scope: 'branch' }, undefined, 'feature/x')).branch, 'feature/x')
  assert.equal(field(gh.calls[0].args, 'branch'), 'feature/x')
  const asked = await listRuns(gh, repo, { query: 'branch:main', after: null, scope: 'branch' }, undefined, 'feature/x')
  assert.equal(asked.branch, null)
  assert.equal(field(gh.calls[1].args, 'branch'), 'main')
  assert.equal((await listRuns(gh, repo, { query: '', after: null, scope: 'all' }, undefined, 'feature/x')).branch, null)
  assert.equal(field(gh.calls[2].args, 'branch'), undefined)
  // Detached, or git failed: every branch.
  assert.equal((await listRuns(gh, repo, { query: '', after: null, scope: 'branch' }, undefined, null)).branch, null)
  assert.equal(field(gh.calls[3].args, 'branch'), undefined)
})
