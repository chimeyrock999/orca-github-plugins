// The plugin's own worker. Orca starts it on the panel's first plugin.request and transpiles
// this file when it loads: no build step. A save restarts it and drops its in-memory state.
import { existsSync } from 'node:fs'
import type { OrcaWorkerApi } from 'orca/worker'
import { currentBranch, terminalPath, workspaceLinks, type WorkspaceLinks } from './worker/exec'
import { runGh, toFailure, type Gh } from './worker/gh'
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
import { isRepoName, type Answer, type LinkedKind, type LinkedRef, type OrcaView } from './shared/protocol'
import { branchPull, commentOnPull, editPull, getPull, pullTimeline, reviewPull } from './worker/pulls/pulls'
import { ghRepo, trackRepo, type RepoDeps, type RepoTracker } from './worker/repo/repo'
import { cancelRun, dispatchWorkflow, getRun, rerunRun, reviewDeployments, runLogs, watchRun, workflowForm, type WatchDeps } from './worker/runs/runs'

export type WorkerDeps = RepoDeps & {
  gh: Gh
  links?: (path: string) => Promise<WorkspaceLinks | null>
  /** The branch checked out in a folder, for the Run workflow form's ref. */
  branch?: (path: string) => Promise<string | null>
  /** The watch's clock, so tests need not wait. */
  watch?: Omit<WatchDeps, 'post'>
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
async function repoLinks(deps: WorkerDeps, repo: RepoRef & { url?: string }, branch: boolean, signal?: AbortSignal): Promise<{ issues: LinkedRef[]; pulls: LinkedRef[] }> {
  const linked = linkedRefs((await deps.links?.(repo.path)) ?? null, repo)
  if (!branch || linked.pulls.some((p) => p.repo === null)) return linked
  const own = await branchPull(deps.gh, repo, signal)
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

export function activateWith(orca: OrcaWorkerApi, deps: WorkerDeps): void {
  const tracker = trackRepo(orca, deps)

  orca.panels.handle('repo.get', () => tracker.get())
  orca.panels.handle('repo.pick', ({ path }) => tracker.pick(path))
  orca.panels.handle('repo.unpick', () => tracker.unpick())
  orca.panels.handle('repo.links', (input, { signal }) => inRepo(tracker, (repo) => repoLinks(deps, repo, !!input?.branch, signal)))
  orca.panels.handle('items.get', ({ kind, items }, { signal }) => inRepo(tracker, (repo) => linkedRows(deps.gh, repo, kind, items, signal)))
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
    inRepo(tracker, async (repo) => listRuns(deps.gh, repo, input, signal, input.scope === 'branch' ? ((await deps.branch?.(repo.path)) ?? null) : null))
  )
  orca.panels.handle('labels.list', (input, { signal }) => inRepo(tracker, (repo) => listLabels(deps.gh, repo, signal), input?.repo))
  orca.panels.handle('workflows.list', (_, { signal }) => inRepo(tracker, (repo) => listWorkflows(deps.gh, repo, signal)))
  orca.panels.handle('assignees.list', (input, { signal }) => inRepo(tracker, (repo) => listAssignees(deps.gh, repo, signal), input?.repo))

  orca.panels.handle('issue.get', ({ number, repo: other }, { signal }) => inRepo(tracker, (repo) => getIssue(deps.gh, repo, number, signal), other))
  orca.panels.handle('issue.timeline', ({ number, after, repo: other }, { signal }) =>
    inRepo(tracker, (repo) => issueTimeline(deps.gh, repo, number, after, signal), other)
  )
  orca.panels.handle('issue.comment', ({ number, body, repo: other }, { signal }) => inRepo(tracker, (repo) => commentOn(deps.gh, repo, number, body, signal), other))
  orca.panels.handle('comment.edit', ({ id, body, repo: other }, { signal }) => inRepo(tracker, (repo) => editComment(deps.gh, repo, id, body, signal), other))
  orca.panels.handle('comment.delete', ({ id, repo: other }, { signal }) => inRepo(tracker, (repo) => deleteComment(deps.gh, repo, id, signal), other))
  orca.panels.handle('issue.close', (input, { signal }) => inRepo(tracker, (repo) => closeIssue(deps.gh, repo, input, signal), input.repo))
  orca.panels.handle('issue.reopen', (input, { signal }) => inRepo(tracker, (repo) => reopenIssue(deps.gh, repo, input, signal), input.repo))
  orca.panels.handle('issue.edit', (input, { signal }) => inRepo(tracker, (repo) => editIssue(deps.gh, repo, input, signal), input.repo))

  orca.panels.handle('pull.get', ({ number, repo: other }, { signal }) => inRepo(tracker, (repo) => getPull(deps.gh, repo, number, signal), other))
  orca.panels.handle('pull.timeline', ({ number, after, repo: other }, { signal }) => inRepo(tracker, (repo) => pullTimeline(deps.gh, repo, number, after, signal), other))
  orca.panels.handle('pull.comment', ({ number, body, repo: other }, { signal }) => inRepo(tracker, (repo) => commentOnPull(deps.gh, repo, number, body, signal), other))
  orca.panels.handle('pull.edit', (input, { signal }) => inRepo(tracker, (repo) => editPull(deps.gh, repo, input, signal), input.repo))
  orca.panels.handle('pull.review', (input, { signal }) => inRepo(tracker, (repo) => reviewPull(deps.gh, repo, input, signal), input.repo))
  orca.panels.handle('reaction.set', (input, { signal }) => inRepo(tracker, (repo) => setReaction(deps.gh, repo, input, signal)))

  orca.panels.handle('run.get', ({ id }, { signal }) => inRepo(tracker, (repo) => getRun(deps.gh, repo, id, signal)))
  orca.panels.handle('run.logs', (input, { signal }) => inRepo(tracker, (repo) => runLogs(deps.gh, repo, input, signal)))
  orca.panels.handle('run.rerun', (input, { signal }) => inRepo(tracker, (repo) => rerunRun(deps.gh, repo, input, signal)))
  orca.panels.handle('run.cancel', ({ id }, { signal }) => inRepo(tracker, (repo) => cancelRun(deps.gh, repo, id, signal)))
  orca.panels.handle('run.review', (input, { signal }) => inRepo(tracker, (repo) => reviewDeployments(deps.gh, repo, input, signal)))
  // Each update goes to the panel that asked only: another panel may show another run.
  orca.panels.handle('run.watch', (input, { signal, panel }) =>
    inRepo(tracker, (repo) => watchRun(deps.gh, repo, input, signal, { ...deps.watch, post: (run) => orca.panels.post('run.progress', { run }, { panel: panel.id }) }))
  )
  orca.panels.handle('workflow.form', (input, { signal }) =>
    inRepo(tracker, async (repo) => workflowForm(deps.gh, repo, input, (await deps.branch?.(repo.path)) ?? null, signal))
  )
  orca.panels.handle('workflow.run', (input, { signal }) => inRepo(tracker, (repo) => dispatchWorkflow(deps.gh, repo, input, signal, deps.watch)))
}

export default function activate(orca: OrcaWorkerApi): void {
  activateWith(orca, defaultDeps)
}
