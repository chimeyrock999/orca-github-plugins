// The plugin's own worker. Orca starts it on the panel's first plugin.request and transpiles
// this file when it loads: no build step. A save restarts it and drops its in-memory state.
import { existsSync } from 'node:fs'
import type { OrcaWorkerApi } from 'orca/worker'
import { terminalPath } from './exec'
import { runGh, toFailure, type Gh } from './gh'
import { listIssues, listLabels, listPulls, listRuns, listWorkflows, type RepoRef } from './lists'
import type { Answer } from './protocol'
import { ghRepo, trackRepo, type RepoDeps, type RepoTracker } from './repo'

export type WorkerDeps = RepoDeps & { gh: Gh }

const gh: Gh = (args, options) => runGh(args, options)
const defaultDeps: WorkerDeps = { gh, ghRepo: (path) => ghRepo(path, gh), terminalPath: (id) => terminalPath(id), exists: existsSync }

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
  orca.panels.handle('issues.list', (input, { signal }) => inRepo(tracker, (repo) => listIssues(deps.gh, repo, input, signal)))
  orca.panels.handle('pulls.list', (input, { signal }) => inRepo(tracker, (repo) => listPulls(deps.gh, repo, input, signal)))
  orca.panels.handle('runs.list', (input, { signal }) => inRepo(tracker, (repo) => listRuns(deps.gh, repo, input, signal)))
  orca.panels.handle('labels.list', (_, { signal }) => inRepo(tracker, (repo) => listLabels(deps.gh, repo, signal)))
  orca.panels.handle('workflows.list', (_, { signal }) => inRepo(tracker, (repo) => listWorkflows(deps.gh, repo, signal)))
}

export default function activate(orca: OrcaWorkerApi): void {
  activateWith(orca, defaultDeps)
}
