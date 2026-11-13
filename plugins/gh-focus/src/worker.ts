// The plugin's own worker. Orca starts it on the panel's first plugin.request and transpiles
// this file when it loads: no build step. A save restarts it and drops its in-memory state.
import { existsSync } from 'node:fs'
import type { OrcaWorkerApi } from 'orca/worker'
import { currentBranch, terminalPath, workspaceLinks, type WorkspaceLinks } from './exec'
import { runGh, toFailure, type Gh } from './gh'
import { hostFailure } from './host-error'
import {
  closeIssue,
  commentOn,
  createIssue,
  deleteComment,
  editComment,
  editIssue,
  getIssue,
  issueTimeline,
  listAssignees,
  reopenIssue,
  setReaction
} from './issues'
import { listIssues, listLabels, listRuns, listWorkflows, type RepoRef } from './lists'
import type { Answer, OrcaView } from './protocol'
import { branchPull, commentOnPull, editPull, getPull, pullTimeline, reviewPull } from './pulls'
import { ghRepo, trackRepo, type RepoDeps, type RepoTracker } from './repo'
import { cancelRun, dispatchWorkflow, getRun, rerunRun, reviewDeployments, runLogs, watchRun, workflowForm, type WatchDeps } from './runs'

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

/** The issue and pull request Orca links to the focused workspace, when they are of its repo. Orca
 *  links a pull request only when the workspace was made from it or it was made in Orca, so with
 *  none and `branch` asked, the branch's pull request (one opened with gh or on GitHub) stands in. */
async function repoLinks(deps: WorkerDeps, repo: RepoRef, branch: boolean, signal?: AbortSignal): Promise<{ issue: number | null; pull: number | null }> {
  const links = await deps.links?.(repo.path)
  const ours = links?.project?.toLowerCase() === `github:${repo.nameWithOwner}`.toLowerCase()
  const linked = ours && links ? { issue: links.issue, pull: links.pull } : { issue: null, pull: null }
  return linked.pull || !branch ? linked : { ...linked, pull: await branchPull(deps.gh, repo, signal) }
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

/** One page from `fetch` for the focused repo, or why there is none. */
async function inRepo<T extends object>(
  tracker: RepoTracker,
  fetch: (repo: RepoRef) => Promise<T>
): Promise<Answer<T>> {
  const repo = await tracker.get()
  if (!repo.ok) return repo
  try {
    return { ok: true, ...(await fetch(repo)) }
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
  orca.panels.handle('orca.show', ({ view }) => showView(orca, view))
  orca.panels.handle('issues.list', (input, { signal }) => inRepo(tracker, (repo) => listIssues(deps.gh, repo, input, signal)))
  orca.panels.handle('runs.list', (input, { signal }) =>
    inRepo(tracker, async (repo) => listRuns(deps.gh, repo, input, signal, input.scope === 'branch' ? ((await deps.branch?.(repo.path)) ?? null) : null))
  )
  orca.panels.handle('labels.list', (_, { signal }) => inRepo(tracker, (repo) => listLabels(deps.gh, repo, signal)))
  orca.panels.handle('workflows.list', (_, { signal }) => inRepo(tracker, (repo) => listWorkflows(deps.gh, repo, signal)))
  orca.panels.handle('assignees.list', (_, { signal }) => inRepo(tracker, (repo) => listAssignees(deps.gh, repo, signal)))

  orca.panels.handle('issue.get', ({ number }, { signal }) => inRepo(tracker, (repo) => getIssue(deps.gh, repo, number, signal)))
  orca.panels.handle('issue.timeline', ({ number, after }, { signal }) =>
    inRepo(tracker, (repo) => issueTimeline(deps.gh, repo, number, after, signal))
  )
  orca.panels.handle('issue.comment', ({ number, body }, { signal }) => inRepo(tracker, (repo) => commentOn(deps.gh, repo, number, body, signal)))
  orca.panels.handle('comment.edit', ({ id, body }, { signal }) => inRepo(tracker, (repo) => editComment(deps.gh, repo, id, body, signal)))
  orca.panels.handle('comment.delete', ({ id }, { signal }) => inRepo(tracker, (repo) => deleteComment(deps.gh, repo, id, signal)))
  orca.panels.handle('issue.close', (input, { signal }) => inRepo(tracker, (repo) => closeIssue(deps.gh, repo, input, signal)))
  orca.panels.handle('issue.reopen', (input, { signal }) => inRepo(tracker, (repo) => reopenIssue(deps.gh, repo, input, signal)))
  orca.panels.handle('issue.edit', (input, { signal }) => inRepo(tracker, (repo) => editIssue(deps.gh, repo, input, signal)))
  orca.panels.handle('issue.create', (input, { signal }) => inRepo(tracker, (repo) => createIssue(deps.gh, repo, input, signal)))

  orca.panels.handle('pull.get', ({ number }, { signal }) => inRepo(tracker, (repo) => getPull(deps.gh, repo, number, signal)))
  orca.panels.handle('pull.timeline', ({ number, after }, { signal }) => inRepo(tracker, (repo) => pullTimeline(deps.gh, repo, number, after, signal)))
  orca.panels.handle('pull.comment', ({ number, body }, { signal }) => inRepo(tracker, (repo) => commentOnPull(deps.gh, repo, number, body, signal)))
  orca.panels.handle('pull.edit', (input, { signal }) => inRepo(tracker, (repo) => editPull(deps.gh, repo, input, signal)))
  orca.panels.handle('pull.review', (input, { signal }) => inRepo(tracker, (repo) => reviewPull(deps.gh, repo, input, signal)))
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
