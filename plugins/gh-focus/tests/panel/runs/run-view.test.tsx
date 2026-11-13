// The Actions tab past the list: a run's detail, logs, writes, the live watch and the Run workflow
// form, over a mock host whose `requests` stand in for src/worker.ts.
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from '../../../src/panel'
import { failedLogs, releaseForm, repoOk, runDetail, runningRun, runPage, runRows, workflows } from '../../fixtures/fixtures'
import type { DispatchForm, RunDetail } from '../../../src/shared/protocol'

const ok = { ok: true } as const

/** A watch that answers "not done yet" `leases` times, then done; the test reads how often it
 *  was asked. (A held request would keep the mock panel from settling, so each answers at once.) */
function leasedWatch(leases: number) {
  let asked = 0
  return () => ({ ok: true, done: ++asked > leases, every: 10_000, mark: null })
}

function host(overrides: Record<string, unknown> = {}, run: () => RunDetail = () => runDetail()) {
  const asked: { name: string; input: unknown }[] = []
  const requests: Record<string, unknown> = {
    'repo.get': () => repoOk,
    'runs.list': () => runPage(runRows, 3),
    'run.get': () => ({ ok: true, run: run() }),
    'run.logs': () => ({ ok: true, logs: failedLogs() }),
    'run.rerun': () => ok,
    'run.cancel': () => ok,
    'run.review': () => ok,
    'run.watch': () => ({ ok: true, done: true }),
    'workflows.list': { ok: true, workflows },
    'workflow.form': () => ({ ok: true, form: releaseForm }),
    'workflow.run': () => ok,
    ...overrides
  }
  const logged = Object.fromEntries(
    Object.entries(requests).map(([name, answer]) => [
      name,
      (input: unknown) => {
        asked.push({ name, input })
        return typeof answer === 'function' ? (answer as (i: unknown) => unknown)(input) : answer
      }
    ])
  )
  return Object.assign(mockHost({ requests: logged }), {
    asked,
    count: (name: string) => asked.filter((a) => a.name === name).length,
    last: (name: string) => asked.filter((a) => a.name === name).at(-1)?.input
  })
}

const onRuns = { persisted: { plugin: { tab: 'runs' } } }

async function openRun(h = host(), title = /Fix token refresh loop/) {
  const view = await mount(panel, { host: h, ...onRuns })
  await view.press({ type: 'ListItem', text: title })
  return view
}

test('the tab starts on the workspace branch; All branches lists every run and Only comes back', async () => {
  const h = host({
    'runs.list': (input: { scope?: string }) => (input.scope === 'branch' ? runPage(runRows.slice(0, 1), 1, null, 1000, 'fix/token-refresh') : runPage(runRows, 3))
  })
  const view = await mount(panel, { host: h, ...onRuns })
  assert.equal((h.last('runs.list') as { scope: string }).scope, 'branch')
  assert.ok(view.find({ text: '1 run on' }))
  assert.ok(view.find({ type: 'Code', text: 'fix/token-refresh' }))
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  await view.press({ type: 'Button', text: 'All branches' })
  assert.equal((h.last('runs.list') as { scope: string }).scope, 'all')
  assert.ok(view.find({ text: '3 workflow runs' }))
  assert.equal(view.findAll({ type: 'ListItem' }).length, 3)
  await view.press({ type: 'Button', text: 'Only fix/token-refresh' })
  assert.equal((h.last('runs.list') as { scope: string }).scope, 'branch')
  await view.unmount()
})

test('a failed run shows its jobs and opens its failed steps by itself', async () => {
  const h = host()
  const view = await openRun(h)
  assert.deepEqual(h.last('run.get'), { id: 9001 })
  assert.ok(view.find({ type: 'Text', text: 'Fix token refresh loop' }))
  assert.ok(view.find({ text: 'Failed' }))
  assert.ok(view.find({ text: '1 of 2 succeeded' }))
  assert.deepEqual(h.last('run.logs'), { id: 9001 })
  const log = view.find({ type: 'CodeView' })
  assert.match(String(log?.props.code), /writes 25k rows/)
  assert.ok(view.find({ type: 'Collapsible', text: /test \(ubuntu-latest\) › Test/ }))
  // A run that is done is not watched.
  assert.equal(h.count('run.watch'), 0)
  assert.ok(view.find({ type: 'Button', text: 'Rerun failed jobs' }))
  assert.equal(view.find({ type: 'Button', text: 'Cancel run…' }), null)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('a trimmed log says how many lines it shows', async () => {
  const view = await openRun(host({ 'run.logs': () => ({ ok: true, logs: failedLogs(12_341) }) }))
  assert.equal(view.find({ type: 'Collapsible' })?.props.description, 'Showing the last 4 of 12,345 lines')
  assert.ok(view.find({ type: 'Button', text: 'Full log on GitHub' }))
  await view.unmount()
})

test('a job opens its steps, and View log reads its whole log', async () => {
  const h = host()
  const view = await openRun(h)
  await view.press({ type: 'ListItem', text: /test \(ubuntu-latest\)/ })
  assert.ok(view.find({ text: 'Install' }))
  assert.ok(view.find({ text: '38s' }))
  await view.press({ type: 'Button', text: 'View log' })
  assert.deepEqual(h.last('run.logs'), { id: 9001, job: 502 })
  assert.ok(view.find({ text: 'Log · test (ubuntu-latest)' }))
  await view.press({ type: 'Button', text: 'Show failed steps only' })
  assert.deepEqual(h.last('run.logs'), { id: 9001 })
  await view.unmount()
})

test('a running run offers no View log (gh reads logs of finished runs only), only the job on GitHub', async () => {
  const view = await openRun(host({ 'run.watch': leasedWatch(0) }, runningRun))
  await view.press({ type: 'ListItem', text: /test \(ubuntu-latest\)/ })
  assert.equal(view.find({ type: 'Button', text: 'View log' }), null)
  assert.ok(view.find({ type: 'Button', text: 'Log on GitHub' }))
  await view.unmount()
})

test('a big run whose steps were cut says so instead of "No steps yet"', async () => {
  const cut = runDetail()
  cut.jobs = cut.jobs.map((j) => ({ ...j, steps: [], stepsCut: true }))
  const view = await openRun(host({}, () => cut))
  await view.press({ type: 'ListItem', text: /lint/ })
  assert.ok(view.find({ text: 'Steps are left out of a run this big; the log has them.' }))
  await view.unmount()
})

test('two steps of a job with the same name keep their own open state', async () => {
  const step = (lines: string[]) => ({ job: 'test', jobId: 502, step: 'Run npm test', lines, dropped: 0, failed: false })
  const logs = { ...failedLogs(), steps: [step(['first']), step(['second'])] }
  const view = await openRun(host({ 'run.logs': () => ({ ok: true, logs }) }))
  await view.press({ type: 'ListItem', text: /test \(ubuntu-latest\)/ })
  await view.press({ type: 'Button', text: 'View log' })
  const [a] = view.findAll({ type: 'Collapsible' })
  await view.toggle(a)
  assert.deepEqual(view.findAll({ type: 'Collapsible' }).map((c) => c.props.open), [true, false])
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a watch the worker ends early says live updates stopped', async () => {
  const h = host({ 'run.watch': () => ({ ok: false, error: { code: 'cancelled', message: 'The panel stopped watching the run.' } }) }, runningRun)
  const view = await openRun(h)
  assert.ok(view.find({ text: 'Live updates stopped: The panel stopped watching the run.' }))
  await view.unmount()
})

test('another tab ends the watch; coming back reads the run and watches it again', async () => {
  const h = host({ 'run.watch': leasedWatch(0) }, runningRun)
  const view = await openRun(h)
  assert.equal(h.count('run.watch'), 1)
  await view.select({ type: 'Tabs' }, 'issues')
  // Not watched off screen: no new lease while Issues shows.
  assert.equal(h.count('run.watch'), 1)
  await view.select({ type: 'Tabs' }, 'runs')
  assert.equal(h.count('run.get'), 2)
  assert.equal(h.count('run.watch'), 2)
  assert.ok(view.find({ text: /Live · updated/ }))
  await view.unmount()
})

const waitingFor = (canApprove = true) => [
  { id: 7, name: 'production', canApprove },
  { id: 8, name: 'staging-eu', canApprove: false }
]
const waiting = (canApprove = true) => () => ({ ...runningRun(), state: 'waiting' as const, waitingFor: waitingFor(canApprove) })
const callout = (view: Awaited<ReturnType<typeof openRun>>, title: string) => view.findAll({ type: 'Callout' }).find((c) => c.props.title === title)

test('a run waiting for a deployment approval names the environments and still hands off to GitHub', async () => {
  const view = await openRun(host({ 'run.watch': leasedWatch(0) }, waiting()))
  assert.ok(callout(view, 'Waiting for approval to deploy to production, staging-eu'))
  assert.ok(view.find({ text: "You can't review staging-eu; a required reviewer must do it on GitHub." }))
  assert.ok(view.find({ type: 'Button', text: 'Approve…' }))
  assert.ok(view.find({ type: 'Button', text: 'Reject…' }))
  assert.ok(view.find({ type: 'Button', text: 'Review deployments on GitHub' }))
  await view.unmount()
})

test('Approve asks first, then approves and reads the run again', async () => {
  const h = host({ 'run.watch': leasedWatch(0), 'run.review': () => ok }, waiting())
  const view = await openRun(h)
  await view.press({ type: 'Button', text: 'Approve…' })
  assert.ok(callout(view, 'Approve deployment to production?'))
  assert.equal(h.count('run.review'), 0)
  await view.press({ type: 'Button', text: 'Keep waiting' })
  assert.equal(callout(view, 'Approve deployment to production?'), undefined)
  await view.press({ type: 'Button', text: 'Approve…' })
  await view.press({ type: 'Button', text: 'Approve' })
  assert.deepEqual(h.last('run.review'), { id: 9001, approve: true, environments: [7] })
  assert.equal(h.count('run.get'), 2)
  // Not a re-run: no new attempt to wait for.
  assert.equal(view.find({ text: /Starting attempt/ }), null)
  await view.unmount()
})

test('a review sent while GitHub still lists the run as waiting is not offered again', async () => {
  const h = host({ 'run.watch': leasedWatch(0), 'run.review': () => ok }, waiting())
  const view = await openRun(h)
  await view.press({ type: 'Button', text: 'Approve…' })
  await view.press({ type: 'Button', text: 'Approve' })
  assert.equal(view.find({ type: 'Button', text: 'Approve…' }), null)
  assert.ok(view.find({ text: 'Review sent for production; GitHub has not moved the run on yet.' }))
  // Once the run moves on and waits again (a rerun), it is offered again.
  await view.post('run.progress', { run: runningRun() })
  await view.post('run.progress', { run: waiting()() })
  assert.ok(view.find({ type: 'Button', text: 'Approve…' }))
  await view.unmount()
})

test('one question at a time: Cancel run drops the review asked about, and the other way round', async () => {
  const view = await openRun(host({ 'run.watch': leasedWatch(0) }, waiting()))
  await view.press({ type: 'Button', text: 'Reject…' })
  await view.press({ type: 'Button', text: 'Cancel run…' })
  assert.equal(callout(view, 'Reject deployment to production?'), undefined)
  assert.ok(view.find({ type: 'Button', text: 'Keep running' }))
  await view.press({ type: 'Button', text: 'Approve…' })
  assert.equal(view.find({ type: 'Button', text: 'Keep running' }), null)
  assert.ok(callout(view, 'Approve deployment to production?'))
  await view.unmount()
})

test('Reject asks first, then rejects and reads the run again', async () => {
  const h = host({ 'run.watch': leasedWatch(0), 'run.review': () => ok }, waiting())
  const view = await openRun(h)
  await view.press({ type: 'Button', text: 'Reject…' })
  assert.ok(callout(view, 'Reject deployment to production?'))
  const reject = view.find({ type: 'Button', text: 'Reject' })
  assert.equal(reject?.props.tone, 'danger')
  await view.press({ type: 'Button', text: 'Reject' })
  assert.deepEqual(h.last('run.review'), { id: 9001, approve: false, environments: [7] })
  assert.equal(h.count('run.get'), 2)
  await view.unmount()
})

test('a deployment this login may not review only hands off to GitHub', async () => {
  const view = await openRun(host({ 'run.watch': leasedWatch(0) }, waiting(false)))
  assert.ok(view.find({ text: "You can't review production, staging-eu; a required reviewer must do it on GitHub." }))
  assert.equal(view.find({ type: 'Button', text: 'Approve…' }), null)
  assert.equal(view.find({ type: 'Button', text: 'Reject…' }), null)
  assert.ok(view.find({ type: 'Button', text: 'Review deployments on GitHub' }))
  await view.unmount()
})

test('an approval with no answer may have gone through: it says so and reads the run again', async () => {
  const h = host(
    {
      'run.watch': leasedWatch(0),
      'run.review': () => {
        throw hostError('timeout', 'plugin.request timed out')
      }
    },
    waiting()
  )
  const view = await openRun(h)
  await view.press({ type: 'Button', text: 'Approve…' })
  await view.press({ type: 'Button', text: 'Approve' })
  assert.ok(callout(view, 'It may have gone through'))
  assert.equal(h.count('run.get'), 2)
  await view.unmount()
})

const day = 24 * 3_600_000
const artifacts = () => [
  { id: 1, name: 'coverage-report', bytes: 4_404_019, expired: false, expiresAt: Date.now() + 89 * day + 3_600_000 },
  { id: 2, name: 'dist', bytes: 831_488, expired: true, expiresAt: Date.now() - day },
  { id: 3, name: 'sbom.json', bytes: 900, expired: false, expiresAt: null }
]

test("a finished run lists its artifacts, expired ones greyed, each opening the run's artifacts on GitHub", async () => {
  const h = host({}, () => runDetail({ artifacts: artifacts() }))
  const view = await openRun(h)
  assert.ok(view.findAll({ type: 'List' }).some((l) => l.props.label === 'Artifacts'))
  const row = (name: string) => view.findAll({ type: 'ListItem' }).find((i) => i.props.title === name)
  assert.deepEqual([row('coverage-report')?.props.description, row('coverage-report')?.props.icon], ['4.2 MB · Expires in 89 days', 'package'])
  assert.equal(row('dist')?.props.description, '812 KB · Expired')
  assert.equal(row('sbom.json')?.props.description, '900 B')
  assert.deepEqual([row('dist')?.props.disabled, row('coverage-report')?.props.disabled], [true, false])
  await view.press({ type: 'ListItem', text: /coverage-report/ })
  assert.deepEqual(h.callsOf('shell.openExternal').at(-1), { url: 'https://github.com/octo/app/actions/runs/9001#artifacts' })
  await view.unmount()
})

test('an expired artifact opens nothing, and those past the first page open on GitHub', async () => {
  const h = host({}, () => runDetail({ artifacts: artifacts(), moreArtifacts: 120 }))
  const view = await openRun(h)
  const dist = view.findAll({ type: 'ListItem' }).find((i) => i.props.title === 'dist')
  assert.equal(dist?.props.disabled, true)
  const opened = h.callsOf('shell.openExternal').length
  await assert.rejects(view.press({ type: 'ListItem', text: /dist/ }))
  assert.equal(h.callsOf('shell.openExternal').length, opened)
  assert.ok(view.find({ text: '123' }))
  await view.press({ type: 'Button', text: '120 more on GitHub' })
  assert.deepEqual(h.callsOf('shell.openExternal').at(-1), { url: 'https://github.com/octo/app/actions/runs/9001#artifacts' })
  await view.unmount()
})

test('a run with no artifacts shows no Artifacts section', async () => {
  const view = await openRun(host())
  assert.ok(view.findAll({ type: 'List' }).every((l) => l.props.label !== 'Artifacts'))
  assert.equal(view.find({ text: 'Artifacts' }), null)
  await view.unmount()
})

test('a failed job whose log could not be read says so beside the ones that could', async () => {
  const logs = { ...failedLogs(), unread: [{ job: 'test (macos-latest)', message: 'log not found' }] }
  const view = await openRun(host({ 'run.logs': () => ({ ok: true, logs }) }))
  assert.ok(view.find({ text: 'test (macos-latest): the log could not be read. log not found' }))
  assert.ok(view.find({ type: 'CodeView' }))
  await view.unmount()
})

test('after a re-run the panel waits for the new attempt: the watch asks for it and the old logs go', async () => {
  let attempt = 1
  const h = host({ 'run.rerun': () => ok, 'run.watch': leasedWatch(0) }, () => runDetail({ attempt }))
  const view = await openRun(h)
  assert.equal(h.count('run.logs'), 1)
  await view.press({ type: 'Button', text: 'Rerun failed jobs' })
  // GitHub still shows attempt 1, finished: the panel keeps watching for attempt 2.
  assert.deepEqual(h.last('run.watch'), { id: 9001, attempt: 2 })
  assert.ok(view.find({ text: /Starting attempt 2/ }))
  assert.equal(view.find({ type: 'Button', text: 'Rerun all jobs' }), null)
  assert.equal(view.find({ type: 'CodeView' }), null)
  attempt = 2
  await view.post('run.progress', { run: runDetail({ attempt: 2, state: 'running', done: false }) })
  assert.ok(view.find({ text: /Live · updated/ }))
  await view.post('run.progress', { run: runDetail({ attempt: 2 }) })
  assert.equal(view.find({ text: /Live · updated|Starting attempt/ }), null)
  assert.ok(view.find({ type: 'Button', text: 'Rerun all jobs' }))
  // The new attempt failed too: its failed steps load.
  assert.equal(h.count('run.logs'), 2)
  await view.unmount()
})

test('Rerun failed jobs sends the write, then reads the run again', async () => {
  let attempt = 1
  const h = host({ 'run.rerun': () => (attempt++, ok) }, () => runDetail({ attempt }))
  const view = await openRun(h)
  await view.press({ type: 'Button', text: 'Rerun failed jobs' })
  assert.deepEqual(h.last('run.rerun'), { id: 9001, failed: true })
  assert.equal(h.count('run.get'), 2)
  await view.press({ type: 'Button', text: 'Rerun all jobs' })
  assert.deepEqual(h.last('run.rerun'), { id: 9001, failed: false })
  assert.equal(h.count('run.get'), 3)
  await view.unmount()
})

test('a re-run with no answer may have landed: it says so and reads the run again', async () => {
  const h = host({
    'run.rerun': () => {
      throw hostError('timeout', 'plugin.request timed out')
    }
  })
  const view = await openRun(h)
  await view.press({ type: 'Button', text: 'Rerun all jobs' })
  assert.ok(view.findAll({ type: 'Callout' }).some((c) => c.props.title === 'It may have gone through'))
  assert.equal(h.count('run.get'), 2)
  await view.unmount()
})

test('a re-run whose answer broke on the way back may have landed; one Orca held back did not', async () => {
  for (const [code, title] of [
    ['action_failed', 'It may have gone through'],
    ['rate_limited', 'Too many requests']
  ]) {
    const h = host({
      'run.rerun': () => {
        throw hostError(code, 'x', 3_000)
      }
    })
    const view = await openRun(h)
    await view.press({ type: 'Button', text: 'Rerun all jobs' })
    assert.ok(view.findAll({ type: 'Callout' }).some((c) => c.props.title === title), code)
    await view.unmount()
  }
})

test('a running run is watched; posts keep it current; Cancel asks first', async () => {
  const h = host({ 'run.watch': leasedWatch(0) }, runningRun)
  const view = await openRun(h)
  assert.deepEqual(h.last('run.watch'), { id: 9001 })
  assert.ok(view.find({ text: /Live · updated/ }))
  assert.equal(h.count('run.logs'), 0)

  await view.press({ type: 'Button', text: 'Cancel run…' })
  assert.ok(view.findAll({ type: 'Callout' }).some((c) => c.props.title === 'Cancel run CI #296?'))
  await view.press({ type: 'Button', text: 'Keep running' })
  assert.equal(h.count('run.cancel'), 0)
  await view.press({ type: 'Button', text: 'Cancel run…' })
  await view.press({ type: 'Button', text: 'Cancel run' })
  assert.deepEqual(h.last('run.cancel'), { id: 9001 })
  assert.equal(h.count('run.get'), 2)

  // The run ended while watched: the post shows it and its failed steps load.
  await view.post('run.progress', { run: runDetail() })
  assert.ok(view.find({ text: 'Failed' }))
  assert.equal(view.find({ text: /Live · updated/ }), null)
  assert.equal(h.count('run.logs'), 1)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('a watch that runs out of lease is asked again until the run is done, then stops', async () => {
  const h = host({ 'run.watch': leasedWatch(3) }, runningRun)
  const view = await openRun(h)
  await view.settled()
  assert.equal(h.count('run.watch'), 4)
  await view.rerender()
  assert.equal(h.count('run.watch'), 4)
  await view.unmount()
})

test('a run left behind is not watched again, and posts for it change nothing', async () => {
  const h = host({ 'run.watch': leasedWatch(0) }, runningRun)
  const view = await openRun(h)
  await view.press({ type: 'Button', text: '← Back to runs' })
  await view.post('run.progress', { run: runDetail() })
  assert.ok(view.find({ type: 'ListItem', text: /Fix token refresh loop/ }))
  assert.equal(h.count('run.watch'), 1)
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('posts update the run row in the list too', async () => {
  const h = host({ 'run.watch': leasedWatch(0) }, runningRun)
  const view = await openRun(h)
  await view.post('run.progress', { run: runDetail() })
  await view.press({ type: 'Button', text: '← Back to runs' })
  const row = view.find({ type: 'ListItem', text: /Fix token refresh loop/ })
  assert.match(row?.text ?? '', /✕/)
  await view.unmount()
})

test('live updates that fail say so and can resume', async () => {
  const h = host({ 'run.watch': () => ({ ok: false, error: { code: 'rate_limited', message: 'API rate limit exceeded' } }) }, runningRun)
  const view = await openRun(h)
  assert.ok(view.find({ text: 'Live updates stopped: API rate limit exceeded' }))
  await view.press({ type: 'Button', text: 'Resume' })
  assert.equal(h.count('run.get'), 2)
  assert.equal(h.count('run.watch'), 2)
  await view.unmount()
})

test('Run workflow: the first workflow, typed inputs with defaults, then the run starts and the list reloads', async () => {
  const h = host()
  const view = await mount(panel, { host: h, ...onRuns })
  const lists = h.count('runs.list')
  await view.press({ label: 'Run workflow' })
  assert.deepEqual(h.last('workflow.form'), { workflow: 77 })
  assert.equal(view.valueOf({ label: 'Branch or tag' }), 'fix/token-refresh')
  assert.equal(view.valueOf({ label: 'channel *' }), 'beta')
  assert.equal(view.valueOf({ label: 'dry_run' }), true)
  // version is required and empty.
  assert.ok(view.find({ text: 'Fill in version.' }))
  assert.equal(view.find({ type: 'Button', text: 'Run workflow' })?.props.disabled, true)
  await view.type({ label: 'version *' }, '1.9.1')
  await view.toggle({ label: 'dry_run' })
  await view.press({ type: 'Button', text: 'Run workflow' })
  assert.deepEqual(h.last('workflow.run'), { workflow: 77, ref: 'fix/token-refresh', inputs: { version: '1.9.1', channel: 'beta', dry_run: 'false' } })
  assert.equal(h.count('runs.list'), lists + 1)
  assert.ok(view.find({ type: 'ListItem', text: /Fix token refresh loop/ }))
  await view.unmount()
})

test('Run workflow: opens the run it started when GitHub shows it in time', async () => {
  const h = host({ 'workflow.run': () => ({ ok: true, run: 9001 }) })
  const view = await mount(panel, { host: h, ...onRuns })
  await view.press({ label: 'Run workflow' })
  await view.type({ label: 'version *' }, '1.9.1')
  await view.press({ type: 'Button', text: 'Run workflow' })
  assert.deepEqual(h.last('run.get'), { id: 9001 })
  assert.ok(view.find({ type: 'Button', text: '← Back to runs' }))
  await view.unmount()
})

test('Run workflow: a run not shown yet is announced on the list, across branches when its ref is another', async () => {
  const h = host({
    'workflow.run': () => ({ ok: true, run: null }),
    'runs.list': (input: { scope?: string }) => (input.scope === 'branch' ? runPage([], 0, null, 1000, 'feature/other') : runPage(runRows, 3))
  })
  const view = await mount(panel, { host: h, ...onRuns })
  await view.press({ label: 'Run workflow' })
  await view.type({ label: 'version *' }, '1.9.1')
  await view.press({ type: 'Button', text: 'Run workflow' })
  assert.ok(view.find({ text: 'Run requested on fix/token-refresh; it shows in a few seconds. Refresh to look again.' }))
  assert.equal((h.last('runs.list') as { scope: string }).scope, 'all')
  await view.press({ label: 'Dismiss' })
  assert.equal(view.find({ text: /Run requested/ }), null)
  await view.unmount()
})

test('Run workflow: another branch reads the form there; a workflow without dispatch cannot run', async () => {
  const noDispatch: DispatchForm = { ref: 'main', dispatch: false, inputs: [] }
  const h = host({ 'workflow.form': (input: { workflow: number; ref?: string }) => ({ ok: true, form: input.workflow === 78 ? noDispatch : { ...releaseForm, ref: input.ref ?? releaseForm.ref } }) })
  const view = await mount(panel, { host: h, ...onRuns })
  await view.press({ label: 'Run workflow' })
  await view.type({ label: 'Branch or tag' }, 'v2', { replace: true, submit: true })
  assert.deepEqual(h.last('workflow.form'), { workflow: 77, ref: 'v2' })
  await view.select({ label: 'Workflow' }, '78')
  assert.ok(view.findAll({ type: 'Callout' }).some((c) => c.props.title === 'This workflow cannot be run by hand'))
  assert.equal(view.find({ type: 'Button', text: 'Run workflow' })?.props.disabled, true)
  await view.unmount()
})

test('Run workflow: a branch typed without Enter blocks Run until the form is read there', async () => {
  const h = host()
  const view = await mount(panel, { host: h, ...onRuns })
  await view.press({ label: 'Run workflow' })
  await view.type({ label: 'version *' }, '1.9.1')
  await view.type({ label: 'Branch or tag' }, 'release/2.0', { replace: true })
  assert.equal(view.find({ type: 'Button', text: 'Run workflow' })?.props.disabled, true)
  assert.ok(view.find({ text: 'Press Enter in Branch or tag to read the workflow at release/2.0.' }))
  await view.submit({ label: 'Branch or tag' })
  assert.deepEqual(h.last('workflow.form'), { workflow: 77, ref: 'release/2.0' })
  await view.unmount()
})

test('Run workflow: Refresh reads the workflows and the form again', async () => {
  const h = host()
  const view = await mount(panel, { host: h, ...onRuns })
  await view.press({ label: 'Run workflow' })
  const forms = h.count('workflow.form')
  await view.press({ label: 'Refresh' })
  assert.equal(h.count('workflow.form'), forms + 1)
  assert.deepEqual(
    view.find({ type: 'Select', label: 'Workflow' })?.props.options,
    workflows.map((w) => ({ value: String(w.id), label: w.name }))
  )
  await view.unmount()
})

test('Run workflow: the workflow and branch cannot change while a run is starting', async () => {
  let land: (v: unknown) => void = () => {}
  const h = host({ 'workflow.run': () => new Promise((r) => (land = r)) })
  const view = await mount(panel, { host: h, ...onRuns })
  await view.press({ label: 'Run workflow' })
  await view.type({ label: 'version *' }, '1.9.1')
  const pressing = view.press({ type: 'Button', text: 'Run workflow' })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(view.find({ type: 'Select', label: 'Workflow' })?.props.disabled, true)
  assert.equal(view.find({ type: 'Input', label: 'Branch or tag' })?.props.disabled, true)
  land(ok)
  await pressing
  assert.ok(view.find({ type: 'ListItem', text: /Fix token refresh loop/ }))
  await view.unmount()
})

test('Run workflow: inputs that could not be read are typed as name and value', async () => {
  const h = host({ 'workflow.form': () => ({ ok: true, form: { ref: 'main', dispatch: true, inputs: null } }) })
  const view = await mount(panel, { host: h, ...onRuns })
  await view.press({ label: 'Run workflow' })
  await view.type({ label: 'Input 1 name' }, 'preview_id')
  await view.type({ label: 'Input 1 value' }, '131')
  await view.press({ type: 'Button', text: 'Add input' })
  await view.press({ type: 'Button', text: 'Run workflow' })
  assert.deepEqual(h.last('workflow.run'), { workflow: 77, ref: 'main', inputs: { preview_id: '131' } })
  await view.unmount()
})

test('Run workflow: a gh failure keeps the form and what was typed', async () => {
  const h = host({ 'workflow.run': () => ({ ok: false, error: { code: 'gh_failed', message: "HTTP 422: Required input 'version' not provided" } }) })
  const view = await mount(panel, { host: h, ...onRuns })
  await view.press({ label: 'Run workflow' })
  await view.type({ label: 'version *' }, '2.0.0')
  await view.press({ type: 'Button', text: 'Run workflow' })
  assert.ok(view.find({ text: "HTTP 422: Required input 'version' not provided" }))
  assert.equal(view.valueOf({ label: 'version *' }), '2.0.0')
  await view.unmount()
})
