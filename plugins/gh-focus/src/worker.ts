// The plugin's own worker. Orca starts it on the panel's first plugin.request and transpiles
// this file when it loads: no build step. A save restarts it and drops its in-memory state.
import { existsSync } from 'node:fs'
import type { OrcaWorkerApi } from 'orca/worker'
import { Budget, LONG_MS, Reads, SHORT_MS, withEtags, type ReadOptions } from './worker/cache'
import { currentBranch, terminalPath, workspaceLinks, type WorkspaceLinks } from './worker/exec'
import { runGh, toFailure, type Gh, type RateLimit } from './worker/gh'
import { hostFailure } from './shared/host-error'
import {
  closeIssue,
  commentOn,
  deleteComment,
  editComment,
  editIssue,
  getIssue,
  issueTimeline,
  listAssignees,
  reopenIssue,
  setReaction
} from './worker/issues/issues'
import { agentName, freeAgent, linkedRefs, linkedRows, linkPrompt, type AgentRow } from './worker/linked/linked'
import { listLabels, listRuns, listWorkflows, type RepoRef } from './worker/lists'
import { isRepoName, type Answer, type GitHubBudget, type LinkedKind, type LinkedRef, type OrcaView, type RunState } from './shared/protocol'
import { commentOnPull, findBranchPull, editPull, getPull, pullTimeline, reviewPull } from './worker/pulls/pulls'
import { ghRepo, trackRepo, type RepoDeps, type RepoTracker } from './worker/repo/repo'
import { cancelRun, dispatchWorkflow, getRun, rerunRun, reviewDeployments, runLogs, watchRun, workflowForm, type WatchDeps } from './worker/runs/runs'

export type WorkerDeps = RepoDeps & {
  gh: Gh
  links?: (path: string) => Promise<WorkspaceLinks | null>
  /** The branch checked out in a folder, for the Run workflow form's ref. */
  branch?: (path: string) => Promise<string | null>
  /** The watch's clock, so tests need not wait. */
  watch?: Omit<WatchDeps, 'post'>
  /** The cache's and the budget's clock. */
  now?: () => number
}

const gh: Gh = (args, options) => runGh(args, options)
const defaultDeps: WorkerDeps = {
  gh,
  ghRepo: (path) => ghRepo(path, gh),
  terminalPath: (id) => terminalPath(id),
  exists: existsSync,
  links: (path) => workspaceLinks(path),
  branch: (path) => currentBranch(path)
}

/** What Orca links to the focused workspace, of its repo or another. Orca links a pull request when
 *  the workspace was made from it, it was made in Orca or someone linked it, so with none of this
 *  repo and `branch` asked, the branch's pull request (one opened with gh or on GitHub) comes first. */
async function repoLinks(
  deps: WorkerDeps,
  repo: RepoRef & { url?: string },
  branch: boolean,
  ownPull: () => Promise<number | null>
): Promise<{ issues: LinkedRef[]; pulls: LinkedRef[] }> {
  const linked = linkedRefs((await deps.links?.(repo.path)) ?? null, repo)
  if (!branch || linked.pulls.some((p) => p.repo === null)) return linked
  const own = await ownPull()
  return own ? { ...linked, pulls: [{ number: own, repo: null, title: null, url: null }, ...linked.pulls] } : linked
}

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '')

/** The free agent to ask among those of Orca's focused workspace, keeping only agents whose terminal
 *  runs in the panel's workspace folder `path`: the panel's workspace can be a pick shared by clones,
 *  not the one Orca focuses, and that agent would link its own workspace. An agent whose folder the
 *  CLI cannot tell is not offered. */
async function findAgent(orca: OrcaWorkerApi, deps: WorkerDeps, path: string): Promise<Answer<{ agent: (AgentRow & { terminalId: string }) | null }>> {
  let agents: AgentRow[]
  try {
    agents = (await orca.host.call('agents.list')).agents
  } catch (error) {
    return { ok: false, error: hostFailure(error) }
  }
  const here = await Promise.all(
    agents.map(async (a) => (a.terminalId && samePath((await deps.terminalPath(a.terminalId).catch(() => null)) ?? '', path) ? [a] : []))
  )
  return { ok: true, agent: freeAgent(here.flat()) }
}

/** Types the link prompt into the agent the panel offered, while it is still free and in the
 *  workspace folder `path`, without Enter: the person reads it and sends it. */
async function askAgent(orca: OrcaWorkerApi, deps: WorkerDeps, path: string, repoUrl: string, kind: LinkedKind, terminalId: string): Promise<Answer<{ agent: string }>> {
  let agent: AgentRow | undefined
  try {
    agent = (await orca.host.call('agents.list')).agents.find((a) => a.terminalId === terminalId)
  } catch (error) {
    return { ok: false, error: hostFailure(error) }
  }
  const folder = agent ? await deps.terminalPath(terminalId).catch(() => null) : null
  if (!agent || !freeAgent([agent]) || !folder || !samePath(folder, path)) {
    return { ok: false, error: { code: 'no_agent', message: 'That agent is busy now, gone, or not in this workspace.' } }
  }
  try {
    const { accepted } = await orca.host.call('terminal.sendText', { terminalId, text: linkPrompt(repoUrl, kind), enter: false })
    if (!accepted) return { ok: false, error: { code: 'no_agent', message: `${agentName(agent)} did not take the text.` } }
    return { ok: true, agent: agentName(agent) }
  } catch (error) {
    return { ok: false, error: hostFailure(error) }
  }
}

const ORCA_ACTIONS: Record<OrcaView, 'view.tasks' | 'sidebar.checks.toggle'> = { tasks: 'view.tasks', checks: 'sidebar.checks.toggle' }

/** Shows one of Orca's own views; a refusal (not the desktop app, no consent) is an answer. */
async function showView(orca: OrcaWorkerApi, view: OrcaView): Promise<Answer<Record<never, never>>> {
  const action = ORCA_ACTIONS[view]
  if (!action) return { ok: false, error: { code: 'gh_failed', message: `Orca has no ${String(view)} view to show.` } }
  try {
    await orca.host.call('commands.run', { action })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: hostFailure(error) }
  }
}

/** What `fetch` answers for the focused repo, or for `other` (`owner/name`, an item Orca links from
 *  another repo; gh still runs in the workspace folder), or why there is none. */
async function inRepo<T extends object>(
  tracker: RepoTracker,
  fetch: (repo: RepoRef) => Promise<T>,
  other?: string
): Promise<Answer<T>> {
  const repo = await tracker.get()
  if (!repo.ok) return repo
  const ours = !other || other.toLowerCase() === repo.nameWithOwner.toLowerCase()
  if (!ours && !isRepoName(other)) return { ok: false, error: { code: 'gh_failed', message: `${other} is not a repo name.` } }
  try {
    return { ok: true, ...(await fetch(ours ? repo : { nameWithOwner: other, path: repo.path, other: true })) }
  } catch (error) {
    return toFailure(error)
  }
}

/** What the panel is told of a low budget. */
const shownBudget = (rate: RateLimit | null): GitHubBudget | null => rate && { limit: rate.limit, remaining: rate.remaining, resetAt: rate.resetAt }

/** A run state that no longer changes by itself. */
const settled = (state: RunState) => state !== 'running' && state !== 'queued' && state !== 'waiting'

/** Which kept answers a write can change: a repo's issues and pull requests (the items, their
 *  timelines, the linked list, the branch's pull request), its runs, or its labels, assignees and
 *  workflows. */
type Area = 'items' | 'runs' | 'meta'
const tagOf = (area: Area, repo: { nameWithOwner: string }) => `${area}:${repo.nameWithOwner.toLowerCase()}`

export function activateWith(orca: OrcaWorkerApi, deps: WorkerDeps): void {
  const budget = new Budget(deps.now, (rate) => orca.panels.post('budget.changed', { budget: shownBudget(rate) }))
  const reads = new Reads(deps.now, () => budget.factor())
  const gh = withEtags(deps.gh, (rate) => budget.see(rate))
  // A repo the workspace no longer shows keeps nothing; another folder of the same repo keeps it
  // all, and so does a focus that found no repo (the next may well be this one again).
  let shown: string | null = null
  const tracker = trackRepo(orca, deps, (_, after) => {
    if (!after.ok) return
    const name = after.nameWithOwner.toLowerCase()
    if (shown && shown !== name) reads.drop(...(['items', 'runs', 'meta'] as const).map((area) => tagOf(area, { nameWithOwner: shown! })))
    shown = name
  })

  /** `fetch`'s answer, or the one kept for the same request of the same repo while it is younger than
   *  `ttlMs`. `also`: tags of other repos the answer reads. */
  function kept<T>(
    area: Area,
    ttlMs: number,
    repo: RepoRef,
    key: unknown[],
    signal: AbortSignal | undefined,
    fetch: (signal: AbortSignal) => Promise<T>,
    { also = [], keep }: { also?: string[]; keep?: (value: T) => boolean } = {}
  ) {
    const tags = [tagOf(area, repo), ...also]
    return reads.read(JSON.stringify([area, repo.nameWithOwner.toLowerCase(), ...key]), { tags, ttlMs, signal, keep: keep as ReadOptions['keep'] }, fetch)
  }

  /** Runs a write, dropping what it can change before (a reload after an unsure write asks GitHub)
   *  and after it, whatever it answered. */
  function written<T>(drop: () => void, write: () => Promise<T>): Promise<T> {
    drop()
    return write().finally(drop)
  }
  const inItems = <T>(repo: RepoRef, write: () => Promise<T>) => written(() => reads.drop(tagOf('items', repo)), write)
  const inRuns = <T>(repo: RepoRef, write: () => Promise<T>) => written(() => reads.drop(tagOf('runs', repo)), write)

  orca.panels.handle('repo.get', () => tracker.get())
  orca.panels.handle('repo.pick', ({ path }) => tracker.pick(path))
  orca.panels.handle('repo.unpick', () => tracker.unpick())
  orca.panels.handle('cache.drop', () => {
    reads.clear()
    return { ok: true as const }
  })
  orca.panels.handle('budget.get', () => ({ ok: true as const, budget: shownBudget(budget.shown()) }))
  orca.panels.handle('repo.links', (input, { signal }) =>
    inRepo(tracker, (repo) =>
      repoLinks(deps, repo, !!input?.branch, async () => {
        // gh finds the pull request from the folder's branch and remotes, so the folder and its branch are part of the key.
        const branch = (await deps.branch?.(repo.path)) ?? null
        // Only an answer is kept: a gh that could not tell is asked again next time.
        return kept('items', SHORT_MS, repo, ['branch', repo.path, branch], signal, (s) => findBranchPull(gh, repo, s)).catch(() => null)
      })
    )
  )
  orca.panels.handle('items.get', ({ kind, items }, { signal }) =>
    inRepo(tracker, (repo) => {
      const others = items.flatMap((i) => (i.repo ? [tagOf('items', { nameWithOwner: i.repo })] : []))
      return kept('items', SHORT_MS, repo, ['items', kind, items.map((i) => [i.repo?.toLowerCase() ?? null, i.number])], signal, (s) => linkedRows(gh, repo, kind, items, s), { also: others })
    })
  )
  orca.panels.handle('agent.find', async () => {
    const repo = await tracker.get()
    if (!repo.ok) return repo
    const found = await findAgent(orca, deps, repo.path)
    return found.ok ? { ok: true as const, agent: found.agent && { name: agentName(found.agent), terminalId: found.agent.terminalId } } : found
  })
  orca.panels.handle('agent.ask', async ({ kind, terminalId }) => {
    const repo = await tracker.get()
    return repo.ok ? askAgent(orca, deps, repo.path, repo.url, kind, terminalId) : repo
  })
  orca.panels.handle('orca.show', ({ view }) => showView(orca, view))
  orca.panels.handle('runs.list', (input, { signal }) =>
    inRepo(tracker, async (repo) => {
      const branch = input.scope === 'branch' ? ((await deps.branch?.(repo.path)) ?? null) : null
      // A page with a run still going is not kept: the panel shows its progress from the watch.
      return kept('runs', SHORT_MS, repo, ['runs', input, branch], signal, (s) => listRuns(gh, repo, input, s, branch), { keep: (p) => p.rows.every((r) => settled(r.state)) })
    })
  )
  orca.panels.handle('labels.list', (input, { signal }) =>
    inRepo(tracker, (repo) => kept('meta', LONG_MS, repo, ['labels'], signal, (s) => listLabels(gh, repo, s)), input?.repo)
  )
  orca.panels.handle('workflows.list', (_, { signal }) => inRepo(tracker, (repo) => kept('meta', LONG_MS, repo, ['workflows'], signal, (s) => listWorkflows(gh, repo, s))))
  orca.panels.handle('assignees.list', (input, { signal }) =>
    inRepo(tracker, (repo) => kept('meta', LONG_MS, repo, ['assignees'], signal, (s) => listAssignees(gh, repo, s)), input?.repo)
  )

  orca.panels.handle('issue.get', ({ number, repo: other }, { signal }) =>
    inRepo(tracker, (repo) => kept('items', SHORT_MS, repo, ['issue', number], signal, (s) => getIssue(gh, repo, number, s)), other)
  )
  orca.panels.handle('issue.timeline', ({ number, after, repo: other }, { signal }) =>
    inRepo(tracker, (repo) => kept('items', SHORT_MS, repo, ['issue.timeline', number, after], signal, (s) => issueTimeline(gh, repo, number, after, s)), other)
  )
  orca.panels.handle('issue.comment', ({ number, body, repo: other }, { signal }) =>
    inRepo(tracker, (repo) => inItems(repo, () => commentOn(gh, repo, number, body, signal)), other)
  )
  orca.panels.handle('comment.edit', ({ id, body, repo: other }, { signal }) => inRepo(tracker, (repo) => inItems(repo, () => editComment(gh, repo, id, body, signal)), other))
  orca.panels.handle('comment.delete', ({ id, repo: other }, { signal }) => inRepo(tracker, (repo) => inItems(repo, () => deleteComment(gh, repo, id, signal)), other))
  orca.panels.handle('issue.close', (input, { signal }) => inRepo(tracker, (repo) => inItems(repo, () => closeIssue(gh, repo, input, signal)), input.repo))
  orca.panels.handle('issue.reopen', (input, { signal }) => inRepo(tracker, (repo) => inItems(repo, () => reopenIssue(gh, repo, input, signal)), input.repo))
  orca.panels.handle('issue.edit', (input, { signal }) => inRepo(tracker, (repo) => inItems(repo, () => editIssue(gh, repo, input, signal)), input.repo))

  orca.panels.handle('pull.get', ({ number, repo: other }, { signal }) =>
    inRepo(tracker, (repo) => kept('items', SHORT_MS, repo, ['pull', number], signal, (s) => getPull(gh, repo, number, s)), other)
  )
  orca.panels.handle('pull.timeline', ({ number, after, repo: other }, { signal }) =>
    inRepo(tracker, (repo) => kept('items', SHORT_MS, repo, ['pull.timeline', number, after], signal, (s) => pullTimeline(gh, repo, number, after, s)), other)
  )
  orca.panels.handle('pull.comment', ({ number, body, repo: other }, { signal }) =>
    inRepo(tracker, (repo) => inItems(repo, () => commentOnPull(gh, repo, number, body, signal)), other)
  )
  orca.panels.handle('pull.edit', (input, { signal }) => inRepo(tracker, (repo) => inItems(repo, () => editPull(gh, repo, input, signal)), input.repo))
  orca.panels.handle('pull.review', (input, { signal }) => inRepo(tracker, (repo) => inItems(repo, () => reviewPull(gh, repo, input, signal)), input.repo))
  // A reaction names its subject by node id only, which may be of any repo's item.
  orca.panels.handle('reaction.set', (input, { signal }) =>
    inRepo(tracker, (repo) => written(() => reads.dropPrefix('items:'), () => setReaction(gh, repo, input, signal)))
  )

  // A run still going is not kept: the watch reads past the cache, and a reopen must not go back.
  orca.panels.handle('run.get', ({ id }, { signal }) =>
    inRepo(tracker, (repo) => kept('runs', SHORT_MS, repo, ['run', id], signal, (s) => getRun(gh, repo, id, s), { keep: (a) => a.run.done }))
  )
  orca.panels.handle('run.logs', (input, { signal }) => inRepo(tracker, (repo) => runLogs(gh, repo, input, signal)))
  orca.panels.handle('run.rerun', (input, { signal }) => inRepo(tracker, (repo) => inRuns(repo, () => rerunRun(gh, repo, input, signal))))
  orca.panels.handle('run.cancel', ({ id }, { signal }) => inRepo(tracker, (repo) => inRuns(repo, () => cancelRun(gh, repo, id, signal))))
  orca.panels.handle('run.review', (input, { signal }) => inRepo(tracker, (repo) => inRuns(repo, () => reviewDeployments(gh, repo, input, signal))))
  // Each update goes to the panel that asked only: another panel may show another run. The watch
  // keeps its own cadence and reads past the cache, each poll a conditional read.
  orca.panels.handle('run.watch', (input, { signal, panel }) =>
    inRepo(tracker, (repo) =>
      watchRun(gh, repo, input, signal, { low: () => budget.low(), ...deps.watch, post: (run) => orca.panels.post('run.progress', { run }, { panel: panel.id }) })
    )
  )
  orca.panels.handle('workflow.form', (input, { signal }) =>
    inRepo(tracker, async (repo) => workflowForm(gh, repo, input, (await deps.branch?.(repo.path)) ?? null, signal))
  )
  orca.panels.handle('workflow.run', (input, { signal }) => inRepo(tracker, (repo) => inRuns(repo, () => dispatchWorkflow(gh, repo, input, signal, deps.watch))))
}

export default function activate(orca: OrcaWorkerApi): void {
  activateWith(orca, defaultDeps)
}
