// One workflow run: the run and its jobs through the REST API, logs and writes through gh's own run
// and workflow commands, and the watch that keeps an open run current while it goes on.
import { GhError, type Gh } from '../gh'
import { runRow, runState, type RepoRef, type RunJson } from '../lists'
import { parseLog, trimSteps } from './logs'
import type { DispatchForm, LogStep, PendingDeployment, RunArtifact, RunDetail, RunJob, RunLogs } from '../../shared/protocol'
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
/** Artifacts one run answer lists (GitHub's largest page): the rest are counted, and open on GitHub. */
export const ARTIFACTS = 100
/** Writes call the API once, but gh may be slow to start: as long as issue writes get. */
const WRITE_MS = 60_000
/** How often a watched run is asked for: every 10 s while it changes, doubling up to 60 s while it
 *  does not, as Orca's Checks tab backs off; and how long one watch request holds (under 120 s). */
export const POLL_MIN_MS = 10_000
export const POLL_MAX_MS = 60_000
/** The shortest wait while the GitHub budget is low. */
export const POLL_LOW_MS = 30_000
export const LEASE_MS = 100_000
/** After Run workflow: how often and how many times to look for the run it started. */
const FIND_MS = 2_000
const FIND_TRIES = 5

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

type JobsPage = { total_count?: number; jobs?: JobJson[] }

/** The jobs of the run's latest attempt, a page at a time (a matrix can pass 100): each page a plain
 *  GET, which can come back 304 while nothing changed. */
async function runJobs(gh: Gh, repo: RepoRef, path: string, signal?: AbortSignal): Promise<JobJson[]> {
  const jobs: JobJson[] = []
  for (let page = 1; ; page++) {
    const out = (await gh(['api', `${path}/jobs?filter=latest&per_page=100${page > 1 ? `&page=${page}` : ''}`], { cwd: repo.path, signal, json: true })) as JobsPage
    if (!Array.isArray(out?.jobs)) throw new GhError('gh_failed', `Unexpected gh output: ${JSON.stringify(out).slice(0, 200)}`)
    jobs.push(...out.jobs)
    if (out.jobs.length === 0 || jobs.length >= (out.total_count ?? jobs.length)) return jobs
  }
}

/** The run and the jobs of its latest attempt, every page of them (a matrix can pass 100). */
export async function getRun(gh: Gh, repo: RepoRef, id: number, signal?: AbortSignal): Promise<{ run: RunDetail }> {
  const path = runPath(repo, id)
  const [run, found] = (await Promise.all([gh(['api', path], { cwd: repo.path, signal, json: true }), runJobs(gh, repo, path, signal)])) as [
    RunJson & { run_attempt?: number; workflow_id?: number },
    JobJson[]
  ]
  if (typeof run?.id !== 'number') {
    throw new GhError('gh_failed', `Unexpected gh output: ${JSON.stringify(run).slice(0, 200)}`)
  }
  const jobs = found.map(jobOf)
  const done = run.status === 'completed'
  const [waitingFor, artifacts] = await Promise.all([
    run.status === 'waiting' ? pendingDeployments(gh, repo, path, signal).catch(skipUnread<PendingDeployment>) : [],
    done ? runArtifacts(gh, repo, path, signal).catch((error) => ({ artifacts: skipUnread<RunArtifact>(error), moreArtifacts: 0 })) : noArtifacts
  ])
  return {
    run: fitRun({ ...runRow(run), attempt: run.run_attempt ?? 1, workflowId: run.workflow_id ?? 0, done, jobs, waitingFor, ...artifacts })
  }
}

/** A part of the run that could not be read is left out; the run still shows. */
function skipUnread<T>(error: unknown): T[] {
  if (error instanceof GhError && error.code !== 'cancelled') return []
  throw error
}

type PendingJson = { environment?: { id?: number; name?: string }; current_user_can_approve?: boolean }

/** The environments a waiting run needs an approval for. None when it waits on something else, such
 *  as a concurrency group. */
async function pendingDeployments(gh: Gh, repo: RepoRef, path: string, signal?: AbortSignal): Promise<PendingDeployment[]> {
  const out = (await gh(['api', `${path}/pending_deployments`], { cwd: repo.path, signal, json: true })) as PendingJson[]
  if (!Array.isArray(out)) return []
  return out.flatMap(({ environment: e, current_user_can_approve }) =>
    typeof e?.id === 'number' && e.name ? [{ id: e.id, name: e.name, canApprove: current_user_can_approve === true }] : []
  )
}

type ArtifactJson = { id: number; name: string; size_in_bytes: number; expired: boolean; expires_at: string | null }
type Artifacts = Pick<RunDetail, 'artifacts' | 'moreArtifacts'>
const noArtifacts: Artifacts = { artifacts: [], moreArtifacts: 0 }

/** The first page of a run's artifacts, so the run stays one panel message; the rest are counted. */
async function runArtifacts(gh: Gh, repo: RepoRef, path: string, signal?: AbortSignal): Promise<Artifacts> {
  const out = (await gh(['api', `${path}/artifacts?per_page=${ARTIFACTS}`], { cwd: repo.path, signal, json: true })) as {
    total_count?: number
    artifacts?: ArtifactJson[]
  }
  const artifacts = (Array.isArray(out?.artifacts) ? out.artifacts : [])
    .slice(0, ARTIFACTS)
    .map((a) => ({ id: a.id, name: a.name, bytes: a.size_in_bytes, expired: a.expired === true, expiresAt: time(a.expires_at) }))
  return { artifacts, moreArtifacts: Math.max(0, (out?.total_count ?? 0) - artifacts.length) }
}

/** Approves or rejects, in one write, the environments the panel showed as this login's to review.
 *  GitHub asks for a comment; the panel sends none, as GitHub's own form allows. */
export async function reviewDeployments(
  gh: Gh,
  repo: RepoRef,
  input: { id: number; approve: boolean; environments: number[] },
  signal?: AbortSignal
): Promise<object> {
  const path = runPath(repo, input.id)
  const ids = (Array.isArray(input.environments) ? input.environments : []).filter((e) => Number.isSafeInteger(e) && e > 0)
  if (ids.length === 0) throw new GhError('gh_failed', 'Choose a deployment to review.')
  const args = ['api', '-X', 'POST', `${path}/pending_deployments`]
  for (const id of ids) args.push('-F', `environment_ids[]=${id}`)
  args.push('-f', `state=${input.approve ? 'approved' : 'rejected'}`, '-f', 'comment=')
  await gh(args, { cwd: repo.path, signal, timeoutMs: WRITE_MS, json: true })
  return {}
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
  /** Whether the GitHub budget is low: the watch then waits at least POLL_LOW_MS. */
  low?: () => boolean
}

/** What a poll compares: the run's and every job's and step's state, as Orca's Checks tab does. */
export function fingerprint(run: RunDetail): string {
  return JSON.stringify([run.attempt, run.state, run.waitingFor, ...run.jobs.map((j) => [j.name, j.state, ...j.steps.map((s) => `${s.name}:${s.state}`)])])
}

/** The next wait: back to the shortest when the run changed, else twice the last, up to the longest. */
export function nextPollMs(last: number, changed: boolean): number {
  return changed ? POLL_MIN_MS : Math.min(Math.max(POLL_MIN_MS, last) * 2, POLL_MAX_MS)
}

export type WatchInput = { id: number; attempt?: number; every?: number; mark?: string }
export type WatchAnswer = { done: boolean; every: number; mark: string | null }

/** Asks for the run and posts it, until it is done, the lease runs out, or the panel stops waiting
 *  (closed, or the request timed out). Never posts after that. The wait backs off while the run
 *  does not change; `every` and `mark` carry it from one lease to the next. With `attempt`, a run
 *  is done only once that attempt is: a re-run starts its new attempt a moment after it is asked. */
export async function watchRun(gh: Gh, repo: RepoRef, input: WatchInput, signal: AbortSignal, deps: WatchDeps): Promise<WatchAnswer> {
  const { id, attempt = 0 } = input
  const wait = deps.sleep ?? sleep
  const now = deps.now ?? Date.now
  const start = now()
  let every = Math.min(Math.max(input.every ?? POLL_MIN_MS, POLL_MIN_MS), POLL_MAX_MS)
  let mark = input.mark ?? null
  for (;;) {
    if (deps.low?.()) every = Math.max(every, POLL_LOW_MS)
    await wait(every, signal)
    if (signal.aborted) throw new GhError('cancelled', 'The panel stopped watching the run.')
    const { run } = await getRun(gh, repo, id, signal)
    if (signal.aborted) throw new GhError('cancelled', 'The panel stopped watching the run.')
    deps.post(run)
    const seen = fingerprint(run)
    every = nextPollMs(every, seen !== mark)
    mark = seen
    if (run.done && run.attempt >= attempt) return { done: true, every, mark }
    if (now() - start + every >= LEASE_MS) return { done: false, every, mark }
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

/** Runs the workflow on `ref`, then looks a few times for the run it started (GitHub makes it a
 *  moment after the event): `run` is its id, or null when it has not shown yet. Empty inputs are
 *  left out, so the workflow's defaults apply. */
export async function dispatchWorkflow(
  gh: Gh,
  repo: RepoRef,
  input: { workflow: number; ref: string; inputs: Record<string, string> },
  signal?: AbortSignal,
  deps: Omit<WatchDeps, 'post'> = {}
): Promise<{ run: number | null }> {
  const ref = input.ref.trim()
  if (!ref) throw new GhError('gh_failed', 'Choose a branch or tag to run the workflow on.')
  const wait = deps.sleep ?? sleep
  const now = deps.now ?? Date.now
  const args = ['workflow', 'run', String(input.workflow), '--ref', ref, '-R', repo.nameWithOwner]
  for (const [name, value] of Object.entries(input.inputs)) if (name.trim() && value !== '') args.push('-f', `${name.trim()}=${value}`)
  // Clocks differ: a run made just before the press would be older still.
  const since = now() - 10_000
  await gh(args, { cwd: repo.path, signal, timeoutMs: WRITE_MS })
  const path = `repos/${repo.nameWithOwner}/actions/workflows/${input.workflow}/runs`
  for (let tries = 0; tries < FIND_TRIES; tries++) {
    await wait(FIND_MS, signal)
    if (signal?.aborted) break
    try {
      const out = (await gh(['api', '-X', 'GET', path, '-f', 'event=workflow_dispatch', '-f', `branch=${ref}`, '-F', 'per_page=5'], {
        cwd: repo.path,
        signal,
        json: true
      })) as { workflow_runs?: { id: number; created_at: string }[] }
      const fresh = (out?.workflow_runs ?? []).find((r) => Date.parse(r.created_at) >= since)
      if (fresh) return { run: fresh.id }
    } catch (error) {
      // The dispatch landed; only finding its run failed.
      if (!(error instanceof GhError) || error.code === 'cancelled') throw error
      break
    }
  }
  return { run: null }
}
