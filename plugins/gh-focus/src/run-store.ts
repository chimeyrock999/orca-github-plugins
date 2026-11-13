// The open run and the Run workflow form, in atoms, and the actions that change them. A run that is
// not done is watched: the worker holds a `run.watch` request and posts `run.progress` while it
// goes on; leaving the run aborts that request, and the panel closing ends it on the worker's side.
import { atom, plugin, read, set, update } from 'orca'
import type { Answer, DispatchForm, PanelError, RunDetail, RunLogs, RunRow } from './protocol'
import { back, choices, lists, load, loadChoices, requestFailed, setScope, tab, unsure } from './store'

/** The log on screen: the run's failed steps (`job` null) or one job's whole log. */
export type LogView = { job: number | null; answer: Answer<{ logs: RunLogs }> | null }

export type OpenRun = {
  id: number
  /** null while the run loads. */
  answer: Answer<{ run: RunDetail }> | null
  /** The job whose steps show under it. */
  openJob: number | null
  logs: LogView | null
  /** Log steps opened or closed by hand, by `job›step`; the rest show open when they failed. */
  openSteps: Record<string, boolean>
  busy: 'rerun' | 'rerun-failed' | 'cancel' | 'approve' | 'reject' | null
  confirmCancel: boolean
  /** The deployment review asked about, before it is sent. */
  confirmReview: 'approve' | 'reject' | null
  /** Environments reviewed from here while the run still waits: GitHub may list them as pending a
   *  moment longer, and a second review would fail. */
  reviewed: number[]
  /** Why the last write failed. */
  error: PanelError | null
  /** When the run was last asked for or posted; shows as "updated 3s ago" while it is live. */
  updatedAt: number | null
  /** Why live updates stopped before the run ended. */
  liveError: PanelError | null
  /** After a re-run: the attempt to wait for. GitHub starts it a moment after the re-run is asked,
   *  so until then the run still reads as the finished attempt before it. */
  awaitAttempt: number
}

export type DispatchState = {
  workflow: number | null
  /** What the Branch box holds; the form is read at `form.ref`. */
  ref: string
  form: Answer<{ form: DispatchForm }> | null
  /** Input values by name; name and value rows when the inputs could not be read. */
  values: Record<string, string>
  rows: { name: string; value: string }[]
  busy: boolean
  error: PanelError | null
}

const freshRun = (id: number): OpenRun => ({
  id,
  answer: null,
  openJob: null,
  logs: null,
  openSteps: {},
  busy: null,
  confirmCancel: false,
  confirmReview: null,
  reviewed: [],
  error: null,
  updatedAt: null,
  liveError: null,
  awaitAttempt: 0
})
const blankDispatch = (): DispatchState => ({ workflow: null, ref: '', form: null, values: {}, rows: [{ name: '', value: '' }], busy: false, error: null })

export const runView = atom<OpenRun>(freshRun(0))
export const dispatch = atom<DispatchState>(blankDispatch())
/** A Run workflow whose run GitHub had not shown yet, for the line over the list. */
export const requested = atom<{ ref: string } | null>(null)
export const forgetRequested = () => set(requested, null)

/** The key the Run workflow form takes in the runs list's `open`. */
export const DISPATCH = 'run-workflow'

/** Writes wait longer than reads; the worker gives gh 60 s. */
const WRITE = { timeoutMs: 90_000 }
/** A watch holds up to 100 s on the worker; the panel waits a little longer. */
const WATCH = { timeoutMs: 120_000 }
/** Logs download a zip per job; the worker gives gh 60 s. */
const LOGS = { timeoutMs: 90_000 }

// Opening another run or leaving it makes answers for the one before stale.
let views = 0
// A write changed a run, so the list is asked for again on the way back.
let listStale = false
// The watch running now and its run, aborted when the run is left.
let watching: AbortController | null = null
let watchingRun: number | null = null

/** On screen: the Actions tab with this run open. Another tab stops its watch until it comes back. */
const isShown = (id: number) => read(tab) === 'runs' && read(lists.runs).open === String(id) && read(runView).id === id

function stopWatch(): void {
  watching?.abort()
  watching = null
  watchingRun = null
}

/** The run is done, and so is the attempt a re-run waits for: nothing changes any more. */
export function settled(s: OpenRun): boolean {
  return !!s.answer?.ok && s.answer.run.done && s.answer.run.attempt >= s.awaitAttempt
}

/** The environments the run waits for that this login may review and has not reviewed from here. */
export function reviewable(s: OpenRun): number[] {
  if (!s.answer?.ok) return []
  return s.answer.run.waitingFor.filter((d) => d.canApprove && !s.reviewed.includes(d.id)).map((d) => d.id)
}

/** The run as it is now, from an answer or a post: the row in the list follows it too. A run no
 *  longer waiting drops the review asked about and the environments reviewed. */
function showRun(run: RunDetail): void {
  update(runView, (s): OpenRun => ({
    ...s,
    answer: { ok: true, run },
    updatedAt: Date.now(),
    ...(run.state === 'waiting' ? {} : { confirmReview: null, reviewed: [] })
  }))
  update(lists.runs, (l) => {
    if (!l.answer?.ok) return l
    const rows = l.answer.rows.map((r) => ((r as RunRow).id === run.id ? rowOf(r as RunRow, run) : r))
    return { ...l, answer: { ...l.answer, rows } }
  })
}

function rowOf(row: RunRow, run: RunDetail): RunRow {
  return { ...row, state: run.state, title: run.title, durationMs: run.durationMs, startedAt: run.startedAt }
}

/** Keeps a run that is not done current, one lease after another, until it is done or left. */
async function watch(): Promise<void> {
  const s = read(runView)
  if (watching || !s.answer?.ok || settled(s)) return
  const id = s.id
  const mine = new AbortController()
  watching = mine
  watchingRun = id
  // The worker's cadence, carried from one lease to the next.
  let cadence: { every?: number; mark?: string } = {}
  try {
    for (;;) {
      const attempt = read(runView).awaitAttempt
      const input = { id, ...(attempt ? { attempt } : {}), ...cadence }
      const answer = await plugin.request('run.watch', input, { ...WATCH, signal: mine.signal }).catch(requestFailed)
      if (mine.signal.aborted || !isShown(id)) return
      if (!answer.ok) {
        // Not this panel's own abort (that returned above): the worker or Orca ended it.
        update(runView, (r) => ({ ...r, liveError: answer.error }))
        return
      }
      if (answer.done || settled(read(runView))) return
      cadence = { every: answer.every, ...(answer.mark === null ? {} : { mark: answer.mark }) }
    }
  } finally {
    if (watching === mine) {
      watching = null
      watchingRun = null
    }
  }
}

/** What the worker posted for the watched run. */
export function progress(run: RunDetail): void {
  if (!isShown(run.id)) {
    // A late post of a run left behind (a new repo, say) ends that run's watch, and no other.
    if (watchingRun === run.id) stopWatch()
    return
  }
  const was = settled(read(runView))
  showRun(run)
  // A run that ended while watched: its failed steps are what to read now.
  const now = read(runView)
  if (!was && settled(now) && run.state === 'failure' && !now.logs) void loadLogs(null)
}

export async function loadRun(): Promise<void> {
  const view = views
  const id = read(runView).id
  const answer = await plugin.request('run.get', { id }).catch(requestFailed)
  if (view !== views) return
  if (answer.ok) showRun(answer.run)
  else update(runView, (s) => ({ ...s, answer }))
  if (!answer.ok) return
  const now = read(runView)
  if (settled(now) && answer.run.state === 'failure' && !now.logs) void loadLogs(null)
  // The watch runs on its own: one lease after another, while the run goes on.
  void watch()
}

/** The tab changed: a run open on Actions is watched only while that tab shows. */
export function tabShown(): Promise<void> | void {
  if (read(tab) !== 'runs') return stopWatch()
  const open = read(lists.runs).open
  if (open && open !== DISPATCH && read(runView).answer?.ok) return loadRun()
}

/** Opens a run from the list. */
export function openRun(id: number): Promise<void> {
  forgetRequested()
  stopWatch()
  views++
  update(lists.runs, (s) => ({ ...s, open: String(id) }))
  set(runView, freshRun(id))
  return loadRun()
}

/** Back to the list, asking for it again when a write changed the run. */
export function backToRuns(): Promise<void> | void {
  stopWatch()
  views++
  back('runs')
  if (!listStale) return
  listStale = false
  return load('runs')
}
export const toggleJob = (job: number) => update(runView, (s) => ({ ...s, openJob: s.openJob === job ? null : job }))
export const toggleStep = (key: string, open: boolean) => update(runView, (s) => ({ ...s, openSteps: { ...s.openSteps, [key]: open } }))

/** The run's failed steps (`job` null) or one job's whole log. */
export async function loadLogs(job: number | null): Promise<void> {
  const view = views
  const id = read(runView).id
  update(runView, (s) => ({ ...s, logs: { job, answer: null }, openSteps: {} }))
  const answer = await plugin.request('run.logs', job === null ? { id } : { id, job }, LOGS).catch(requestFailed)
  if (view !== views || read(runView).logs?.job !== job) return
  update(runView, (s) => ({ ...s, logs: { job, answer } }))
}

// One question at a time: asking one drops the other.
export const askCancel = (on: boolean) => update(runView, (s) => ({ ...s, confirmCancel: on, confirmReview: on ? null : s.confirmReview, error: null }))
export const askReview = (which: OpenRun['confirmReview']) =>
  update(runView, (s) => ({ ...s, confirmReview: which, confirmCancel: which ? false : s.confirmCancel, error: null }))
export const dismissError = () => update(runView, (s) => ({ ...s, error: null }))

/** A write on the open run, then the run again; a write with no answer reads it again too, since it
 *  may have landed. */
async function write(busy: NonNullable<OpenRun['busy']>, send: () => Promise<Answer<object>>, sent: number[] = []): Promise<void> {
  if (read(runView).busy) return
  const view = views
  update(runView, (s) => ({ ...s, busy, error: null }))
  const answer = await send().catch(requestFailed)
  if (view !== views) return
  listStale = true
  if (answer.ok) {
    // A re-run starts a new attempt; until GitHub shows it the run reads as the one before.
    update(runView, (s) => ({
      ...s,
      busy: null,
      confirmCancel: false,
      confirmReview: null,
      reviewed: [...s.reviewed, ...sent],
      logs: null,
      openSteps: {},
      liveError: null,
      awaitAttempt: !busy.startsWith('rerun') || !s.answer?.ok ? s.awaitAttempt : s.answer.run.attempt + 1
    }))
    return loadRun()
  }
  const error = unsure(answer.error)
  // A review that may have landed is not offered again; one that failed is.
  update(runView, (s) => ({ ...s, busy: null, confirmReview: null, reviewed: error.code === 'unsure' ? [...s.reviewed, ...sent] : s.reviewed, error }))
  if (error.code === 'unsure') return loadRun()
}

export function rerun(failed: boolean): Promise<void> {
  const id = read(runView).id
  return write(failed ? 'rerun-failed' : 'rerun', () => plugin.request('run.rerun', { id, failed }, WRITE))
}

export function cancelRun(): Promise<void> {
  const id = read(runView).id
  return write('cancel', () => plugin.request('run.cancel', { id }, WRITE))
}

/** Approves or rejects the deployments the run waits for that this login may review, as shown. */
export function reviewDeployments(approve: boolean): Promise<void> {
  const s = read(runView)
  const environments = reviewable(s)
  return write(approve ? 'approve' : 'reject', () => plugin.request('run.review', { id: s.id, approve, environments }, WRITE), environments)
}

/** Starts watching again after live updates stopped on an error. */
export function resumeLive(): Promise<void> {
  update(runView, (s) => ({ ...s, liveError: null }))
  return loadRun()
}

// A newer form load makes the one before stale.
let forms = 0
// Leaving or opening the form again makes a Run workflow answer for the one before stale.
let dispatches = 0

/** Opens the Run workflow form on the workflow the list is filtered by, else the first one. */
export async function startDispatch(): Promise<void> {
  forgetRequested()
  stopWatch()
  views++
  dispatches++
  const filtered = Number.parseInt(read(lists.runs).filters.workflow ?? '', 10)
  update(lists.runs, (s) => ({ ...s, open: DISPATCH }))
  set(dispatch, blankDispatch())
  await loadChoices('workflows')
  const workflow = Number.isFinite(filtered) ? filtered : (read(choices).workflows?.[0]?.id ?? null)
  if (workflow !== null && read(lists.runs).open === DISPATCH && read(dispatch).workflow === null) return pickWorkflow(workflow)
}

export function pickWorkflow(workflow: number): Promise<void> {
  update(dispatch, (s) => ({ ...s, workflow, form: null, values: {}, rows: [{ name: '', value: '' }], error: null }))
  return loadForm()
}

/** Reads the form at the Branch box's ref, or the default ref when it is empty. */
export async function loadForm(): Promise<void> {
  const mine = ++forms
  const { workflow, ref } = read(dispatch)
  if (workflow === null) return
  update(dispatch, (s) => ({ ...s, form: null, error: null }))
  const answer = await plugin.request('workflow.form', ref.trim() ? { workflow, ref: ref.trim() } : { workflow }).catch(requestFailed)
  if (mine !== forms) return
  update(dispatch, (s) => {
    if (!answer.ok) return { ...s, form: answer }
    // Defaults fill the fields; what the person already typed for an input of the same name stays.
    const values: Record<string, string> = {}
    for (const input of answer.form.inputs ?? []) {
      values[input.name] = s.values[input.name] ?? (input.default === null ? '' : String(input.default))
    }
    return { ...s, form: answer, ref: answer.form.ref, values }
  })
}

export const setRef = (ref: string) => update(dispatch, (s) => ({ ...s, ref }))
export const setValue = (name: string, value: string) => update(dispatch, (s) => ({ ...s, values: { ...s.values, [name]: value } }))
export const setRow = (i: number, change: Partial<{ name: string; value: string }>) =>
  update(dispatch, (s) => ({ ...s, rows: s.rows.map((r, k) => (k === i ? { ...r, ...change } : r)) }))
export const addRow = () => update(dispatch, (s) => ({ ...s, rows: [...s.rows, { name: '', value: '' }] }))

/** The required inputs still empty. */
export function missing(s: DispatchState): string[] {
  const form = s.form?.ok ? s.form.form : null
  return (form?.inputs ?? []).filter((i) => i.required && i.type !== 'boolean' && !s.values[i.name]?.trim()).map((i) => i.name)
}

/** The Branch box holds another ref than the form was read at (typed, Enter not pressed yet). */
export function refChanged(s: DispatchState): boolean {
  return !!s.form?.ok && s.ref.trim() !== s.form.form.ref
}

export async function runWorkflow(): Promise<void> {
  const s = read(dispatch)
  const form = s.form?.ok ? s.form.form : null
  if (s.busy || s.workflow === null || !form?.dispatch || missing(s).length || refChanged(s)) return
  const inputs = form.inputs ? s.values : Object.fromEntries(s.rows.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.value]))
  const mine = dispatches
  update(dispatch, (d) => ({ ...d, busy: true, error: null }))
  const answer = await plugin.request('workflow.run', { workflow: s.workflow, ref: form.ref, inputs }, WRITE).catch(requestFailed)
  // The form was left meanwhile: the run may have started, and the list shows it when asked.
  if (mine !== dispatches || read(lists.runs).open !== DISPATCH) {
    if (read(lists.runs).open === null) return load('runs')
    listStale = true
    return
  }
  if (!answer.ok) {
    update(dispatch, (d) => ({ ...d, busy: false, error: unsure(answer.error) }))
    return
  }
  set(dispatch, blankDispatch())
  listStale = true
  if (typeof answer.run === 'number') return openRun(answer.run)
  // Not shown by GitHub yet: say so on the list, which lists every branch when the run's is another.
  set(requested, { ref: form.ref })
  views++
  back('runs')
  if (read(lists.runs).branch && read(lists.runs).branch !== form.ref) return setScope('all')
  return load('runs')
}

export function leaveDispatch(): void {
  forms++
  dispatches++
  set(dispatch, blankDispatch())
  back('runs')
}
