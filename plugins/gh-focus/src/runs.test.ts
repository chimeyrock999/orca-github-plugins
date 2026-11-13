// One run over a fake gh: the gh arguments each request builds, the run and jobs it maps, logs,
// writes, the Run workflow form, and the watch's lease and stop.
import { assert, test } from 'orca/testing'
import { GhError, type Gh, type GhOptions } from './gh'
import type { RunDetail } from './protocol'
import {
  cancelRun,
  dispatchWorkflow,
  FAILED_JOBS,
  fitRun,
  getRun,
  LEASE_MS,
  LOG_BUFFER,
  POLL_MAX_MS,
  POLL_MIN_MS,
  rerunRun,
  reviewDeployments,
  runLogs,
  sleep,
  watchRun,
  workflowForm
} from './runs'

const repo = { nameWithOwner: 'octo/app', path: '/code/app' }

type Call = { args: string[]; options?: GhOptions }
/** A gh whose answer is picked by the first route the joined arguments match. */
function routedGh(routes: [RegExp, unknown | ((args: string[]) => unknown)][]): Gh & { calls: Call[] } {
  const calls: Call[] = []
  const gh: Gh = async (args, options) => {
    calls.push({ args, options })
    const route = routes.find(([pattern]) => pattern.test(args.join(' ')))
    if (!route) throw new Error(`unexpected gh ${args.join(' ')}`)
    const answer = typeof route[1] === 'function' ? (route[1] as (a: string[]) => unknown)(args) : route[1]
    if (answer instanceof Error) throw answer
    return answer
  }
  return Object.assign(gh, { calls })
}

// As the REST API answers (abridged).
const runJson = (change: Record<string, unknown> = {}) => ({
  id: 43380486297,
  name: 'Code OSS',
  display_title: 'fix: stream CSV export past 10k rows',
  run_number: 482,
  run_attempt: 2,
  workflow_id: 925645,
  event: 'pull_request',
  status: 'completed',
  conclusion: 'failure',
  head_branch: 'stream-export',
  head_sha: '9c1ab88aa1',
  actor: { login: 'kenji' },
  run_started_at: '2026-11-13T06:40:00Z',
  updated_at: '2026-11-13T06:46:02Z',
  html_url: 'https://github.com/octo/app/actions/runs/43380486297',
  pull_requests: [{ number: 131 }],
  ...change
})
const step = (number: number, name: string, conclusion: string | null, status = 'completed') => ({
  number,
  name,
  status,
  conclusion,
  started_at: status === 'queued' ? null : '2026-11-13T06:42:17Z',
  completed_at: status === 'completed' ? '2026-11-13T06:42:53Z' : null
})
const job = (id: number, name: string, conclusion: string | null, status = 'completed', steps = [step(1, 'Set up job', 'success'), step(6, 'Test', conclusion, status)]) => ({
  id,
  name,
  html_url: `https://github.com/octo/app/actions/runs/43380486297/job/${id}`,
  status,
  conclusion,
  started_at: status === 'queued' ? null : '2026-11-13T06:42:17Z',
  completed_at: status === 'completed' ? '2026-11-13T06:42:53Z' : null,
  steps
})
const jobsPages = [{ total_count: 3, jobs: [job(11, 'lint', 'success'), job(12, 'test (ubuntu)', 'failure')] }, { jobs: [job(13, 'build', null, 'queued', [])] }]

const runRoutes = (run = runJson(), pages: unknown = jobsPages, artifacts: unknown = { total_count: 0, artifacts: [] }): [RegExp, unknown][] => [
  [/^api --paginate --slurp repos\/octo\/app\/actions\/runs\/43380486297\/jobs\?filter=latest&per_page=100$/, pages],
  [/^api repos\/octo\/app\/actions\/runs\/43380486297\/artifacts\?per_page=100$/, artifacts],
  [/^api repos\/octo\/app\/actions\/runs\/43380486297$/, run]
]

test('run.get maps the run and the jobs and steps of every page of its latest attempt', async () => {
  const gh = routedGh(runRoutes())
  const { run } = await getRun(gh, repo, 43380486297)
  assert.equal(run.title, 'fix: stream CSV export past 10k rows')
  assert.equal(run.state, 'failure')
  assert.equal(run.attempt, 2)
  assert.equal(run.workflowId, 925645)
  assert.equal(run.pullNumber, 131)
  assert.equal(run.done, true)
  assert.equal(run.durationMs, 362_000)
  assert.deepEqual(run.jobs.map((j) => [j.id, j.name, j.state, j.durationMs]), [
    [11, 'lint', 'success', 36_000],
    [12, 'test (ubuntu)', 'failure', 36_000],
    [13, 'build', 'queued', null]
  ])
  assert.deepEqual(run.jobs[1].steps, [
    { number: 1, name: 'Set up job', state: 'success', durationMs: 36_000 },
    { number: 6, name: 'Test', state: 'failure', durationMs: 36_000 }
  ])
  assert.equal(run.jobs[2].startedAt, null)
  assert.ok(gh.calls.every((c) => c.options?.cwd === '/code/app' && c.options?.json === true))
})

test('a run in progress is not done, and its running step has no duration yet', async () => {
  const gh = routedGh(runRoutes(runJson({ status: 'in_progress', conclusion: null }), [{ jobs: [job(12, 'test', null, 'in_progress')] }]))
  const { run } = await getRun(gh, repo, 43380486297)
  assert.equal(run.done, false)
  assert.equal(run.state, 'running')
  assert.deepEqual(run.jobs[0].steps.map((s) => [s.state, s.durationMs]), [['success', 36_000], ['running', null]])
})

test('a bad id answers not_found without running gh', async () => {
  const gh = routedGh([])
  await assert.rejects(getRun(gh, repo, -1), (e: unknown) => e instanceof GhError && e.code === 'not_found')
  assert.equal(gh.calls.length, 0)
})

const FAILED_LOG = 'test (ubuntu)\tTest\t2026-11-13T06:42:37Z ✕ writes 25k rows\ntest (ubuntu)\tTest\t2026-11-13T06:42:53Z ##[error]Process completed with exit code 1.\n'

test('run.logs reads the failed steps of each failed job, one gh call per job, with a bigger buffer', async () => {
  const gh = routedGh([...runRoutes(), [/^run view --job 12 --log-failed -R octo\/app$/, FAILED_LOG]])
  const { logs } = await runLogs(gh, repo, { id: 43380486297 })
  assert.deepEqual(logs.steps, [
    { job: 'test (ubuntu)', jobId: 12, step: 'Test', lines: ['✕ writes 25k rows', '##[error]Process completed with exit code 1.'], dropped: 0, failed: true }
  ])
  assert.equal(logs.url, 'https://github.com/octo/app/actions/runs/43380486297')
  assert.equal(logs.skippedJobs, 0)
  const call = gh.calls.find((c) => c.args[0] === 'run')
  assert.equal(call?.options?.maxBuffer, LOG_BUFFER)
  assert.ok((call?.options?.timeoutMs ?? 0) >= 60_000)
})

test('run.logs reads at most a few failed jobs and says how many it left', async () => {
  const many = [{ jobs: Array.from({ length: FAILED_JOBS + 2 }, (_, i) => job(100 + i, `shard ${i}`, 'failure')) }]
  const gh = routedGh([...runRoutes(runJson(), many), [/^run view --job \d+ --log-failed/, (args: string[]) => `shard\tTest\t2026-11-13T06:42:37Z job ${args[3]}\n`]])
  const { logs } = await runLogs(gh, repo, { id: 43380486297 })
  assert.equal(logs.steps.length, FAILED_JOBS)
  assert.equal(logs.skippedJobs, 2)
})

test('run.logs with a job reads only that job, its whole log, and marks the steps that failed', async () => {
  const log = 'test (ubuntu)\tSet up job\t2026-11-13T06:42:17Z Runner\n' + FAILED_LOG
  const gh = routedGh([
    [/^api repos\/octo\/app\/actions\/jobs\/12$/, { ...job(12, 'test (ubuntu)', 'failure'), run_id: 43380486297 }],
    [/^run view --job 12 --log -R octo\/app$/, log]
  ])
  const { logs } = await runLogs(gh, repo, { id: 43380486297, job: 12 })
  assert.deepEqual(logs.steps.map((s) => [s.step, s.failed, s.jobId]), [
    ['Set up job', false, 12],
    ['Test', true, 12]
  ])
  assert.equal(logs.url, 'https://github.com/octo/app/actions/runs/43380486297/job/12')
  assert.equal(gh.calls.length, 2)
})

test('run.logs for a job of another run is not_found', async () => {
  const gh = routedGh([[/^api repos\/octo\/app\/actions\/jobs\/999$/, { ...job(999, 'other', 'failure'), run_id: 1 }]])
  await assert.rejects(runLogs(gh, repo, { id: 43380486297, job: 999 }), (e: unknown) => e instanceof GhError && e.code === 'not_found')
})

test('a failed job whose log gh cannot read is listed; the others still show', async () => {
  const two = [{ jobs: [job(12, 'test (ubuntu)', 'failure'), job(14, 'test (macos)', 'failure')] }]
  const gh = routedGh([
    ...runRoutes(runJson(), two),
    [/^run view --job 12 --log-failed/, FAILED_LOG],
    [/^run view --job 14 --log-failed/, new GhError('gh_failed', 'gh answered with more output than the panel reads.')]
  ])
  const { logs } = await runLogs(gh, repo, { id: 43380486297 })
  assert.deepEqual(logs.steps.map((s) => s.jobId), [12])
  assert.deepEqual(logs.unread, [{ job: 'test (macos)', message: 'gh answered with more output than the panel reads.' }])
})

test('when no failed job log can be read, the error is the answer', async () => {
  const gh = routedGh([...runRoutes(), [/^run view --job 12 --log-failed/, new GhError('gh_failed', 'log not found')]])
  await assert.rejects(runLogs(gh, repo, { id: 43380486297 }), (e: unknown) => e instanceof GhError && e.message === 'log not found')
})

test('a run too big for one message drops the steps of passed jobs first, then all steps', async () => {
  const { run } = await getRun(routedGh(runRoutes()), repo, 43380486297)
  const big = { ...run, jobs: Array.from({ length: 40 }, (_, i) => ({ ...run.jobs[i % 2], id: i })) }
  const size = (r: RunDetail) => Buffer.byteLength(JSON.stringify(r))
  assert.equal(fitRun(big, size(big)), big)
  const passedOnly = fitRun(big, size(big) - 1)
  assert.ok(passedOnly.jobs.filter((j) => j.state === 'success').every((j) => j.steps.length === 0))
  assert.ok(passedOnly.jobs.filter((j) => j.state === 'failure').every((j) => j.steps.length > 0))
  assert.ok(passedOnly.jobs.filter((j) => j.state === 'success').every((j) => j.stepsCut === true))
  const none = fitRun(big, size(passedOnly) - 1)
  assert.ok(none.jobs.every((j) => j.steps.length === 0 && j.stepsCut === true))
  // A matrix at GitHub's 256-job limit, every job failed with its steps, fits one message.
  const huge = { ...run, jobs: Array.from({ length: 256 }, (_, i) => ({ ...run.jobs[1], id: i, steps: Array.from({ length: 20 }, (_, k) => ({ ...run.jobs[1].steps[0], number: k })) })) }
  assert.ok(size(fitRun(huge)) < 256 * 1024)
})

test('rerun, rerun failed and cancel run gh run in the repo with a write timeout', async () => {
  const gh = routedGh([[/^run (rerun|cancel)/, '']])
  await rerunRun(gh, repo, { id: 7, failed: false })
  await rerunRun(gh, repo, { id: 7, failed: true })
  await cancelRun(gh, repo, 7)
  assert.deepEqual(gh.calls.map((c) => c.args), [
    ['run', 'rerun', '7', '-R', 'octo/app'],
    ['run', 'rerun', '7', '-R', 'octo/app', '--failed'],
    ['run', 'cancel', '7', '-R', 'octo/app']
  ])
  assert.ok(gh.calls.every((c) => c.options?.timeoutMs === 60_000 && c.options.cwd === '/code/app'))
})

const DISPATCH_YAML = `on:
  workflow_dispatch:
    inputs:
      version:
        required: true
      environment:
        type: environment
        default: staging
`

test('workflow.form starts on the workspace branch when GitHub has it, and lists environments', async () => {
  const gh = routedGh([
    [/^api repos\/octo\/app\/branches\/stream-export$/, { name: 'stream-export' }],
    [/^workflow view 925645 --yaml --ref stream-export -R octo\/app$/, DISPATCH_YAML],
    [/^api repos\/octo\/app\/environments/, { environments: [{ name: 'staging' }, { name: 'production' }] }]
  ])
  const { form } = await workflowForm(gh, repo, { workflow: 925645 }, 'stream-export')
  assert.equal(form.ref, 'stream-export')
  assert.equal(form.dispatch, true)
  assert.deepEqual(form.inputs?.map((i) => [i.name, i.type, i.required, i.options]), [
    ['version', 'string', true, []],
    ['environment', 'environment', false, ['staging', 'production']]
  ])
})

test('workflow.form falls back to the default branch for a branch GitHub does not have', async () => {
  const gh = routedGh([
    [/^api repos\/octo\/app\/branches\/local-only$/, new GhError('not_found', 'HTTP 404')],
    [/^api repos\/octo\/app$/, { default_branch: 'main' }],
    [/^workflow view 1 --yaml --ref main/, 'on: push\n']
  ])
  const { form } = await workflowForm(gh, repo, { workflow: 1 }, 'local-only')
  assert.deepEqual(form, { ref: 'main', dispatch: false, inputs: [] })
})

test('workflow.form reads at the ref asked for, and with no branch at the default', async () => {
  const asked = routedGh([[/^workflow view 1 --yaml --ref v2 /, 'on: workflow_dispatch\n']])
  assert.equal((await workflowForm(asked, repo, { workflow: 1, ref: ' v2 ' }, 'dev')).form.ref, 'v2')
  const detached = routedGh([
    [/^api repos\/octo\/app$/, { default_branch: 'dev' }],
    [/^workflow view 1 --yaml --ref dev/, 'on: workflow_dispatch\n']
  ])
  assert.equal((await workflowForm(detached, repo, { workflow: 1 }, null)).form.ref, 'dev')
})

/** A clock that moves only when the watch sleeps; `slept` lists each wait. */
function clock(start = 0) {
  let t = start
  const slept: number[] = []
  return { slept, now: () => t, sleep: async (ms: number) => void (slept.push(ms), (t += ms)) }
}

const NOW = Date.parse('2026-11-13T07:00:00Z')

test('workflow.run passes each filled input as a raw field and leaves empty ones to their defaults', async () => {
  const gh = routedGh([
    [/^workflow run/, ''],
    [/^api -X GET repos\/octo\/app\/actions\/workflows\/\d+\/runs/, { workflow_runs: [] }]
  ])
  await dispatchWorkflow(gh, repo, { workflow: 925645, ref: 'main', inputs: { version: '1.9.1', note: '@notes.md', empty: '' } }, undefined, clock(NOW))
  assert.deepEqual(gh.calls[0].args, ['workflow', 'run', '925645', '--ref', 'main', '-R', 'octo/app', '-f', 'version=1.9.1', '-f', 'note=@notes.md'])
  await assert.rejects(dispatchWorkflow(gh, repo, { workflow: 1, ref: ' ', inputs: {} }), (e: unknown) => e instanceof GhError)
})

test('workflow.run finds the run it started once GitHub shows it, ignoring older runs', async () => {
  let looks = 0
  const older = { id: 1, created_at: '2026-11-13T06:00:00Z' }
  const gh = routedGh([
    [/^workflow run/, ''],
    [/^api -X GET repos\/octo\/app\/actions\/workflows\/77\/runs -f event=workflow_dispatch -f branch=main/, () => ({ workflow_runs: ++looks < 2 ? [older] : [{ id: 99, created_at: '2026-11-13T07:00:03Z' }, older] })]
  ])
  assert.deepEqual(await dispatchWorkflow(gh, repo, { workflow: 77, ref: 'main', inputs: {} }, undefined, clock(NOW)), { run: 99 })
  assert.equal(looks, 2)
})

test('workflow.run answers no run when GitHub has not shown it after a few looks, or the look fails', async () => {
  const none = routedGh([[/^workflow run/, ''], [/^api -X GET/, { workflow_runs: [] }]])
  const c = clock(NOW)
  assert.deepEqual(await dispatchWorkflow(none, repo, { workflow: 77, ref: 'main', inputs: {} }, undefined, c), { run: null })
  assert.equal(c.slept.length, 5)
  const failing = routedGh([[/^workflow run/, ''], [/^api -X GET/, new GhError('rate_limited', 'API rate limit exceeded')]])
  assert.deepEqual(await dispatchWorkflow(failing, repo, { workflow: 77, ref: 'main', inputs: {} }, undefined, clock(NOW)), { run: null })
})

function stateRoutes(states: string[]) {
  let n = 0
  return runRoutes(undefined, [{ jobs: [] }]).map(([pattern, answer]): [RegExp, unknown] =>
    /jobs|artifacts/.test(pattern.source) ? [pattern, answer] : [pattern, () => runJson({ status: states[Math.min(n++, states.length - 1)], conclusion: null })]
  )
}

test('run.watch posts the run at each poll and answers done once it completes', async () => {
  const posted: RunDetail[] = []
  const gh = routedGh(stateRoutes(['in_progress', 'in_progress', 'completed']))
  const answer = await watchRun(gh, repo, { id: 43380486297 }, new AbortController().signal, { ...clock(), post: (run) => posted.push(run) })
  assert.equal(answer.done, true)
  assert.deepEqual(posted.map((r) => r.done), [false, false, true])
})

test('run.watch backs off while the run does not change and comes back to 10 s when it does', async () => {
  let moved = false
  const gh = routedGh([
    [/jobs/, () => [{ jobs: [job(12, 'test', null, 'in_progress', [step(1, 'Test', moved ? 'success' : null, moved ? 'completed' : 'in_progress')])] }]],
    [/^api repos\/octo\/app\/actions\/runs\/43380486297$/, runJson({ status: 'in_progress', conclusion: null })]
  ])
  const c = clock()
  const answer = await watchRun(gh, repo, { id: 43380486297 }, new AbortController().signal, { ...c, post: () => {} })
  // The first poll is new; the rest find nothing changed and wait twice as long, up to 60 s.
  assert.deepEqual(c.slept, [POLL_MIN_MS, POLL_MIN_MS, 20_000, 40_000])
  assert.deepEqual([answer.done, answer.every], [false, POLL_MAX_MS])
  // The next lease carries the cadence on; a change brings it back to the shortest wait.
  moved = true
  const next = clock()
  await watchRun(gh, repo, { id: 43380486297, every: answer.every, mark: answer.mark ?? undefined }, new AbortController().signal, { ...next, post: () => {} })
  assert.deepEqual(next.slept.slice(0, 3), [POLL_MAX_MS, POLL_MIN_MS, 20_000])
})

// As GET pending_deployments answers (abridged).
const pending = (id: number, name: string, canApprove: boolean) => ({ environment: { id, name }, wait_timer: 0, current_user_can_approve: canApprove })

test('a waiting run names the environments that need an approval, and which this login may review', async () => {
  const gh = routedGh([
    ...runRoutes(runJson({ status: 'waiting', conclusion: null }), [{ jobs: [] }]),
    [/pending_deployments$/, [pending(7, 'production', true), pending(8, 'staging-eu', false)]]
  ])
  const { run } = await getRun(gh, repo, 43380486297)
  assert.equal(run.state, 'waiting')
  assert.deepEqual(run.waitingFor, [
    { id: 7, name: 'production', canApprove: true },
    { id: 8, name: 'staging-eu', canApprove: false }
  ])
  const done = await getRun(routedGh(runRoutes()), repo, 43380486297)
  assert.deepEqual(done.run.waitingFor, [])
})

test('run.review approves or rejects the environments it is given in one write, with an empty comment', async () => {
  for (const [approve, state] of [
    [true, 'approved'],
    [false, 'rejected']
  ] as const) {
    const gh = routedGh([[/^api -X POST /, []]])
    assert.deepEqual(await reviewDeployments(gh, repo, { id: 43380486297, approve, environments: [7, 9] }), {})
    assert.deepEqual(gh.calls.map((c) => c.args), [
      [
        'api',
        '-X',
        'POST',
        'repos/octo/app/actions/runs/43380486297/pending_deployments',
        '-F',
        'environment_ids[]=7',
        '-F',
        'environment_ids[]=9',
        '-f',
        `state=${state}`,
        '-f',
        'comment='
      ]
    ])
    assert.equal(gh.calls[0].options?.cwd, '/code/app')
  }
})

test('run.review with no environment, or a bad run id, fails before it writes', async () => {
  for (const input of [
    { id: 43380486297, approve: true, environments: [] },
    { id: 43380486297, approve: true, environments: [0, -3] },
    { id: -1, approve: true, environments: [7] },
    // A request without the list, as `orca plugin dev request` could send.
    { id: 43380486297, approve: true } as unknown as { id: number; approve: boolean; environments: number[] }
  ]) {
    const gh = routedGh([])
    await assert.rejects(reviewDeployments(gh, repo, input), (e: unknown) => e instanceof GhError)
    assert.equal(gh.calls.length, 0)
  }
})

// As GET artifacts answers (abridged).
const artifact = (id: number, name: string, size: number, expired: boolean, expires: string | null) => ({
  id,
  name,
  size_in_bytes: size,
  expired,
  expires_at: expires,
  archive_download_url: `https://api.github.com/repos/octo/app/actions/artifacts/${id}/zip`
})

test('a finished run lists its artifacts, expired ones too, and counts those past the first page', async () => {
  const page = {
    total_count: 103,
    artifacts: [artifact(1, 'coverage', 4_404_019, false, '2027-02-11T06:46:02Z'), artifact(2, 'dist', 831_488, true, '2026-11-01T00:00:00Z'), artifact(3, 'sbom.json', 18_000, false, null)]
  }
  const { run } = await getRun(routedGh(runRoutes(runJson(), jobsPages, page)), repo, 43380486297)
  assert.deepEqual(run.artifacts, [
    { id: 1, name: 'coverage', bytes: 4_404_019, expired: false, expiresAt: Date.parse('2027-02-11T06:46:02Z') },
    { id: 2, name: 'dist', bytes: 831_488, expired: true, expiresAt: Date.parse('2026-11-01T00:00:00Z') },
    { id: 3, name: 'sbom.json', bytes: 18_000, expired: false, expiresAt: null }
  ])
  assert.equal(run.moreArtifacts, 100)
})

test('a run still going is not asked for artifacts, and artifacts that cannot be read leave the run whole', async () => {
  const going = routedGh(runRoutes(runJson({ status: 'in_progress', conclusion: null })))
  assert.deepEqual((await getRun(going, repo, 43380486297)).run.artifacts, [])
  assert.ok(going.calls.every((c) => !c.args.join(' ').includes('artifacts')))
  const refused = routedGh(runRoutes(runJson(), jobsPages, new GhError('gh_failed', 'HTTP 403: Resource not accessible')))
  const { run } = await getRun(refused, repo, 43380486297)
  assert.deepEqual([run.state, run.artifacts, run.moreArtifacts], ['failure', [], 0])
})

test('run.watch answers not done before its lease runs out, so the panel asks again', async () => {
  const posted: RunDetail[] = []
  const gh = routedGh(stateRoutes(['in_progress']))
  const answer = await watchRun(gh, repo, { id: 43380486297 }, new AbortController().signal, { ...clock(), post: (run) => posted.push(run) })
  assert.equal(answer.done, false)
  // 10 + 10 + 20 + 40 s, and the next 60 s wait would pass the lease.
  assert.equal(posted.length, 4)
  assert.ok(80_000 + answer.every >= LEASE_MS)
})

test('run.watch after a re-run waits for the new attempt, not the finished one before it', async () => {
  const posted: RunDetail[] = []
  let n = 0
  const gh = routedGh(
    runRoutes(undefined, [{ jobs: [] }]).map(([pattern, answer]): [RegExp, unknown] =>
      /jobs|artifacts/.test(pattern.source)
        ? [pattern, answer]
        : [pattern, () => (++n === 1 ? runJson({ run_attempt: 1 }) : runJson({ run_attempt: 2, status: n === 2 ? 'queued' : 'completed', conclusion: n === 2 ? null : 'success' }))]
    )
  )
  const answer = await watchRun(gh, repo, { id: 43380486297, attempt: 2 }, new AbortController().signal, { ...clock(), post: (run) => posted.push(run) })
  assert.equal(answer.done, true)
  assert.deepEqual(posted.map((r) => [r.attempt, r.state]), [
    [1, 'failure'],
    [2, 'queued'],
    [2, 'success']
  ])
})

test('run.watch stops when the panel stops waiting and posts nothing after', async () => {
  const posted: RunDetail[] = []
  const stop = new AbortController()
  const gh = routedGh(stateRoutes(['in_progress']))
  let polls = 0
  const watching = watchRun(gh, repo, { id: 43380486297 }, stop.signal, {
    now: () => 0,
    sleep: async () => {
      if (++polls === 3) stop.abort()
    },
    post: (run) => posted.push(run)
  })
  await assert.rejects(watching, (e: unknown) => e instanceof GhError && e.code === 'cancelled')
  assert.equal(posted.length, 2)
})

test('sleep ends early on abort', async () => {
  const stop = new AbortController()
  const started = Date.now()
  const slept = sleep(10_000, stop.signal)
  stop.abort()
  await slept
  assert.ok(Date.now() - started < 1_000)
})
