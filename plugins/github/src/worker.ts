// The plugin's own worker. Orca starts it on the panel's first plugin.request and transpiles
// this file when it loads: no build step. A save restarts it and drops its in-memory state.
import { existsSync } from 'node:fs'
import type { OrcaWorkerApi } from 'orca/worker'
import { terminalPath, workspaceLinks, type WorkspaceLinks } from './exec'
import { runGh, toFailure, type Gh } from './gh'
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
import { listIssues, listLabels, listPulls, listRuns, listWorkflows, type RepoRef } from './lists'
import type { Answer } from './protocol'
import { ghRepo, trackRepo, type RepoDeps, type RepoTracker } from './repo'

export type WorkerDeps = RepoDeps & { gh: Gh; links?: (path: string) => Promise<WorkspaceLinks | null> }

const gh: Gh = (args, options) => runGh(args, options)
const defaultDeps: WorkerDeps = {
  gh,
  ghRepo: (path) => ghRepo(path, gh),
  terminalPath: (id) => terminalPath(id),
  exists: existsSync,
  links: (path) => workspaceLinks(path)
}

/** The issue and pull request Orca links to the focused workspace, when they are of its repo. */
async function repoLinks(deps: WorkerDeps, repo: RepoRef): Promise<{ issue: number | null; pull: number | null }> {
  const links = await deps.links?.(repo.path)
  const ours = links?.project?.toLowerCase() === `github:${repo.nameWithOwner}`.toLowerCase()
  return ours && links ? { issue: links.issue, pull: links.pull } : { issue: null, pull: null }
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
  orca.panels.handle('repo.links', () => inRepo(tracker, (repo) => repoLinks(deps, repo)))
  orca.panels.handle('issues.list', (input, { signal }) => inRepo(tracker, (repo) => listIssues(deps.gh, repo, input, signal)))
  orca.panels.handle('pulls.list', (input, { signal }) => inRepo(tracker, (repo) => listPulls(deps.gh, repo, input, signal)))
  orca.panels.handle('runs.list', (input, { signal }) => inRepo(tracker, (repo) => listRuns(deps.gh, repo, input, signal)))
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
  orca.panels.handle('reaction.set', (input, { signal }) => inRepo(tracker, (repo) => setReaction(deps.gh, repo, input, signal)))
}

export default function activate(orca: OrcaWorkerApi): void {
  activateWith(orca, defaultDeps)
}
