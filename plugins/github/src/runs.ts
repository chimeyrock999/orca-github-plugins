// One workflow run: the run and its jobs through the REST API, logs and writes through gh's own run
// and workflow commands, and the watch that keeps an open run current while it goes on.
import { GhError, type Gh } from './gh'
import { runRow, runState, type RepoRef, type RunJson } from './lists'
import { parseLog, trimSteps } from './logs'
import type { DispatchForm, LogStep, RunDetail, RunJob, RunLogs } from './protocol'
import { dispatchInputs } from './workflow-inputs'

/** Logs download a zip and can be long: more time and output than a list call gets (Orca's own
 *  Checks panel reads job logs with a 64 MiB buffer too). */
export const LOG_MS = 60_000
export const LOG_BUFFER = 64 * 1024 * 1024
/** Failed jobs whose failed steps one answer reads, as Orca's Checks panel does; each is its own gh
 *  call. */
export const FAILED_JOBS = 5
/** JSON bytes a run may take in one answer or post; a big matrix drops steps to fit (256 KiB limit). */
export const RUN_BYTES = 200_000
/** Writes call the API once, but gh may be slow to start: as long as issue writes get. */
const WRITE_MS = 60_000
/** How often a watched run is asked for, and how long one watch request holds (under 120 s). */
export const POLL_MS = 5_000
export const LEASE_MS = 100_000

type StepJson = { name: string; number: number; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null }
type JobJson = {
  id: number
  name: string
  html_url: string
  status: string
  conclusion: string | null
  started_at: string | null
  completed_at: string | null
  steps?: StepJson[]
}

function time(value: string | null | undefined): number | null {
  const at = value ? Date.parse(value) : NaN
  return Number.isFinite(at) && at > 0 ? at : null
}

function span(status: string, start: string | null, end: string | null): number | null {
  const from = time(start)
  const to = time(end)
  return status === 'completed' && from !== null && to !== null ? Math.max(0, to - from) : null
}

function jobOf(job: JobJson): RunJob {
  return {
    id: job.id,
    name: job.name,
    url: job.html_url,
    state: runState(job.status, job.conclusion),
    startedAt: time(job.started_at),
    durationMs: span(job.status, job.started_at, job.completed_at),
    steps: (job.steps ?? []).map((s) => ({
      number: s.number,
      name: s.name,
      state: runState(s.status, s.conclusion),
      durationMs: span(s.status, s.started_at, s.completed_at)
    }))
  }
}

function runPath(repo: RepoRef, id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new GhError('not_found', `No run has the id ${id}.`)
  return `repos/${repo.nameWithOwner}/actions/runs/${id}`
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

/** The run as it fits one panel message: when a big matrix does not, finished jobs that passed lose
 *  their steps first, then every job. A job with no steps still opens its log. */
export function fitRun(run: RunDetail, budget = RUN_BYTES): RunDetail {
  if (jsonBytes(run) <= budget) return run
  const cut = (j: RunJob): RunJob => (j.steps.length ? { ...j, steps: [], stepsCut: true } : j)
  const passed = { ...run, jobs: run.jobs.map((j) => (j.state === 'success' || j.state === 'skipped' ? cut(j) : j)) }
  if (jsonBytes(passed) <= budget) return passed
  return { ...run, jobs: run.jobs.map(cut) }
}

/** The run and the jobs of its latest attempt, every page of them (a matrix can pass 100). */
export async function getRun(gh: Gh, repo: RepoRef, id: number, signal?: AbortSignal): Promise<{ run: RunDetail }> {
  const path = runPath(repo, id)
  const [run, pages] = (await Promise.all([
    gh(['api', path], { cwd: repo.path, signal, json: true }),
    gh(['api', '--paginate', '--slurp', `${path}/jobs?filter=latest&per_page=100`], { cwd: repo.path, signal, json: true })
  ])) as [RunJson & { run_attempt?: number; workflow_id?: number }, { jobs?: JobJson[] }[]]
  if (typeof run?.id !== 'number' || !Array.isArray(pages)) {
    throw new GhError('gh_failed', `Unexpected gh output: ${JSON.stringify(run).slice(0, 200)}`)
  }
  const jobs = pages.flatMap((p) => p?.jobs ?? []).map(jobOf)
  return {
    run: fitRun({ ...runRow(run), attempt: run.run_attempt ?? 1, workflowId: run.workflow_id ?? 0, done: run.status === 'completed', jobs })
  }
}

function logOf(gh: Gh, repo: RepoRef, job: number, which: '--log' | '--log-failed', signal?: AbortSignal): Promise<string> {
  const args = ['run', 'view', '--job', String(job), which, '-R', repo.nameWithOwner]
  return gh(args, { cwd: repo.path, signal, timeoutMs: LOG_MS, maxBuffer: LOG_BUFFER }) as Promise<string>
}

/** Why a job's log could not be read: the others still show. */
function unreadOf(job: RunJob, error: unknown): { job: string; message: string } {
  if (error instanceof GhError && error.code !== 'cancelled') return { job: job.name, message: error.message }
  throw error
}

/** A run's failed steps, job by job (gh reads a job's log in about a second, a whole run's in tens),
 *  or with `job` that job's whole log with its failed steps marked. Trimmed to one panel message.
 *  gh reads logs of a finished run only. */
export async function runLogs(gh: Gh, repo: RepoRef, input: { id: number; job?: number }, signal?: AbortSignal): Promise<{ logs: RunLogs }> {
  if (input.job !== undefined) {
    if (!Number.isSafeInteger(input.job) || input.job <= 0) throw new GhError('not_found', `No job has the id ${input.job}.`)
    const json = (await gh(['api', `repos/${repo.nameWithOwner}/actions/jobs/${input.job}`], { cwd: repo.path, signal, json: true })) as JobJson & {
      run_id?: number
    }
    if (json?.run_id !== input.id) throw new GhError('not_found', `Run ${input.id} has no job ${input.job}.`)
    const job = jobOf(json)
    const failed = new Set(job.steps.filter((s) => s.state === 'failure').map((s) => s.name))
    const steps = parseLog(await logOf(gh, repo, job.id, '--log', signal), false).map((s) => ({ ...s, jobId: job.id, failed: failed.has(s.step) }))
    return { logs: { steps: trimSteps(steps), url: job.url, skippedJobs: 0, unread: [] } }
  }
  const { run } = await getRun(gh, repo, input.id, signal)
  const failedJobs = run.jobs.filter((j) => j.state === 'failure')
  const read = failedJobs.slice(0, FAILED_JOBS)
  const logs = await Promise.allSettled(read.map((j) => logOf(gh, repo, j.id, '--log-failed', signal)))
  const steps: LogStep[] = []
  const unread: { job: string; message: string }[] = []
  logs.forEach((log, k) => {
    if (log.status === 'fulfilled') steps.push(...parseLog(log.value, true).map((s) => ({ ...s, jobId: read[k].id })))
    else unread.push(unreadOf(read[k], log.reason))
  })
  // Nothing read at all: the reason is the answer.
  if (read.length > 0 && unread.length === read.length) throw (logs[0] as PromiseRejectedResult).reason
  return { logs: { steps: trimSteps(steps), url: run.url, skippedJobs: failedJobs.length - read.length, unread } }
}

export async function rerunRun(gh: Gh, repo: RepoRef, input: { id: number; failed: boolean }, signal?: AbortSignal): Promise<object> {
  runPath(repo, input.id)
  const args = ['run', 'rerun', String(input.id), '-R', repo.nameWithOwner, ...(input.failed ? ['--failed'] : [])]
  await gh(args, { cwd: repo.path, signal, timeoutMs: WRITE_MS })
  return {}
}

export async function cancelRun(gh: Gh, repo: RepoRef, id: number, signal?: AbortSignal): Promise<object> {
  runPath(repo, id)
  await gh(['run', 'cancel', String(id), '-R', repo.nameWithOwner], { cwd: repo.path, signal, timeoutMs: WRITE_MS })
  return {}
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done)
  })
}

export type WatchDeps = {
  post: (run: RunDetail) => void
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

/** Asks for the run every POLL_MS and posts it, until it is done, the lease runs out, or the panel
 *  stops waiting (closed, or the request timed out). Never posts after that. With `attempt`, a run
 *  is done only once that attempt is: a re-run starts its new attempt a moment after it is asked. */
export async function watchRun(
  gh: Gh,
  repo: RepoRef,
  input: { id: number; attempt?: number },
  signal: AbortSignal,
  deps: WatchDeps
): Promise<{ done: boolean }> {
  const { id, attempt = 0 } = input
  const wait = deps.sleep ?? sleep
  const now = deps.now ?? Date.now
  const start = now()
  for (;;) {
    await wait(POLL_MS, signal)
    if (signal.aborted) throw new GhError('cancelled', 'The panel stopped watching the run.')
    const { run } = await getRun(gh, repo, id, signal)
    if (signal.aborted) throw new GhError('cancelled', 'The panel stopped watching the run.')
    deps.post(run)
    if (run.done && run.attempt >= attempt) return { done: true }
    if (now() - start + POLL_MS >= LEASE_MS) return { done: false }
  }
}

/** The ref a Run workflow form starts on: the workspace's branch when GitHub has it, else the
 *  repo's default branch. */
async function defaultRef(gh: Gh, repo: RepoRef, branch: string | null, signal?: AbortSignal): Promise<string> {
  if (branch) {
    try {
      await gh(['api', `repos/${repo.nameWithOwner}/branches/${encodeURIComponent(branch)}`], { cwd: repo.path, signal, json: true })
      return branch
    } catch (error) {
      if (!(error instanceof GhError) || error.code !== 'not_found') throw error
    }
  }
  const info = (await gh(['api', `repos/${repo.nameWithOwner}`], { cwd: repo.path, signal, json: true })) as { default_branch?: string }
  if (!info?.default_branch) throw new GhError('gh_failed', 'GitHub did not say which branch is the default.')
  return info.default_branch
}

async function environments(gh: Gh, repo: RepoRef, signal?: AbortSignal): Promise<string[]> {
  try {
    const out = (await gh(['api', `repos/${repo.nameWithOwner}/environments?per_page=100`], { cwd: repo.path, signal, json: true })) as {
      environments?: { name: string }[]
    }
    return (out?.environments ?? []).map((e) => e.name)
  } catch (error) {
    // No environments, or no right to list them: the input is then typed by hand.
    if (error instanceof GhError && error.code !== 'cancelled') return []
    throw error
  }
}

/** The Run workflow form: the workflow file at the ref, and its `workflow_dispatch` inputs. */
export async function workflowForm(
  gh: Gh,
  repo: RepoRef,
  input: { workflow: number; ref?: string },
  branch: string | null,
  signal?: AbortSignal
): Promise<{ form: DispatchForm }> {
  const ref = input.ref?.trim() || (await defaultRef(gh, repo, branch, signal))
  const yaml = (await gh(['workflow', 'view', String(input.workflow), '--yaml', '--ref', ref, '-R', repo.nameWithOwner], {
    cwd: repo.path,
    signal
  })) as string
  const { dispatch, inputs } = dispatchInputs(yaml)
  if (inputs?.some((i) => i.type === 'environment')) {
    const names = await environments(gh, repo, signal)
    for (const i of inputs) if (i.type === 'environment') i.options = names
  }
  return { form: { ref, dispatch, inputs } }
}

/** Runs the workflow on `ref`. Empty inputs are left out, so the workflow's defaults apply. */
export async function dispatchWorkflow(
  gh: Gh,
  repo: RepoRef,
  input: { workflow: number; ref: string; inputs: Record<string, string> },
  signal?: AbortSignal
): Promise<object> {
  if (!input.ref.trim()) throw new GhError('gh_failed', 'Choose a branch or tag to run the workflow on.')
  const args = ['workflow', 'run', String(input.workflow), '--ref', input.ref.trim(), '-R', repo.nameWithOwner]
  for (const [name, value] of Object.entries(input.inputs)) if (name.trim() && value !== '') args.push('-f', `${name.trim()}=${value}`)
  await gh(args, { cwd: repo.path, signal, timeoutMs: WRITE_MS })
  return {}
}
