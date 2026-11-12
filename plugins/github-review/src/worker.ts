// The plugin's own worker. Orca starts it on the panel's first plugin.request and transpiles
// this file when it loads: no build step. A save restarts it and drops its in-memory state, so
// the total lives in orca.storage (the storage:own capability).
import { existsSync } from 'node:fs'
import type { OrcaWorkerApi } from 'orca/worker'
import { ghRepo, terminalPath, type GhRepoAnswer } from './exec'
import { resolveFocus, type FocusContext, type FocusDeps } from './focus'
import type { RepoAnswer } from './protocol'

const TOTAL = 'total'

async function storedTotal(orca: OrcaWorkerApi): Promise<number> {
  const value = await orca.storage.get(TOTAL)
  return typeof value === 'number' ? value : 0
}

export type WorkerDeps = FocusDeps & { ghRepo: (path: string) => Promise<GhRepoAnswer> }

const defaultDeps: WorkerDeps = { ghRepo: (path) => ghRepo(path), terminalPath: (id) => terminalPath(id), exists: existsSync }

export function activateWith(orca: OrcaWorkerApi, deps: WorkerDeps): void {
  orca.panels.handle('counter.get', async () => ({ total: await storedTotal(orca) }))

  orca.panels.handle('counter.add', async ({ by }) => {
    const total = (await storedTotal(orca)) + by
    await orca.storage.set(TOTAL, total)
    // Every open panel hears it, so a second panel stays in step.
    orca.panels.post('counter.changed', { total })
    return { total }
  })

  // One answer per focus: a newer workspace.changed supersedes a resolve still in flight.
  let current: Promise<RepoAnswer> | null = null
  let generation = 0
  let posted: string | null = null
  // A folder's repo does not change with focus, so a found repo is kept; errors are asked again.
  // Concurrent asks for one folder share the gh run.
  const repos = new Map<string, Promise<GhRepoAnswer>>()
  // Terminal ids stay the same while the terminal lives, and so does its folder.
  const terminals = new Map<string, string>()

  function repoOf(path: string): Promise<GhRepoAnswer> {
    const cached = repos.get(path)
    if (cached) return cached
    const answer = deps.ghRepo(path)
    repos.set(path, answer)
    void answer.then((a) => a.ok || repos.delete(path), () => repos.delete(path))
    return answer
  }

  const focusDeps: FocusDeps = {
    exists: deps.exists,
    terminalPath: async (id) => {
      const known = terminals.get(id)
      if (known) return known
      const path = await deps.terminalPath(id)
      if (path) terminals.set(id, path)
      return path
    }
  }

  function hostFailed(error: unknown): RepoAnswer {
    return { ok: false, error: { code: 'host_failed', message: String((error as Error)?.message ?? error) } }
  }

  async function resolve(context: FocusContext | null): Promise<RepoAnswer> {
    try {
      const { workspaces, truncated } = await orca.host.call('workspace.list')
      const focus = await resolveFocus(context, workspaces, focusDeps)
      if (!focus.ok) {
        if (truncated && focus.error.code === 'workspace_not_found') {
          return { ok: false, error: { ...focus.error, message: `${focus.error.message} Orca listed only part of the workspaces.` } }
        }
        return focus
      }
      const { path } = focus.workspace
      const repo = await repoOf(path)
      if (!repo.ok) return { ok: false, error: { ...repo.error, path } }
      return { ok: true, nameWithOwner: repo.nameWithOwner, path, resolvedBy: focus.resolvedBy }
    } catch (error) {
      return hostFailed(error)
    }
  }

  async function follow(context: FocusContext | null): Promise<void> {
    const mine = ++generation
    current = resolve(context)
    const answer = await current
    if (mine !== generation) return
    const key = JSON.stringify(answer)
    if (key === posted) return
    posted = key
    orca.panels.post('repo.changed', answer)
  }

  orca.events.on('workspace.changed', ({ context }) => follow(context))

  orca.panels.handle('repo.get', async () => {
    if (!current) {
      const mine = ++generation
      current = orca.host.call('workspace.readContext').then(resolve, hostFailed)
      // The panel has this answer: the first workspace.changed need not post it again.
      void current.then((answer) => {
        if (mine === generation) posted = JSON.stringify(answer)
      })
    }
    // Wait out focus changes that land while this one resolves.
    let answer: RepoAnswer
    let seen: Promise<RepoAnswer>
    do {
      seen = current
      answer = await seen
    } while (seen !== current)
    return answer
  })
}

export default function activate(orca: OrcaWorkerApi): void {
  activateWith(orca, defaultDeps)
}
