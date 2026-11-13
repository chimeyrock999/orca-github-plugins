// The focused workspace's GitHub repo: src/focus.ts finds the workspace folder, gh names its repo.
// The tracker follows workspace.changed and tells open panels when the answer changes.
import type { OrcaWorkerApi } from 'orca/worker'
import { toFailure, type Gh } from './gh'
import { resolveFocus, type FocusContext, type FocusDeps } from './focus'
import type { Answer, RepoAnswer } from './protocol'

export type GhRepoAnswer = Answer<{ nameWithOwner: string; url: string }>

/** `owner/name` and web URL of the repo gh picks for the folder, by gh's own remote rules. */
export async function ghRepo(path: string, gh: Gh): Promise<GhRepoAnswer> {
  try {
    const out = (await gh(['repo', 'view', '--json', 'nameWithOwner,url'], { cwd: path, json: true })) as {
      nameWithOwner?: unknown
      url?: unknown
    }
    if (typeof out?.nameWithOwner === 'string' && out.nameWithOwner.includes('/') && typeof out.url === 'string') {
      return { ok: true, nameWithOwner: out.nameWithOwner, url: out.url }
    }
    return { ok: false, error: { code: 'gh_failed', message: `Unexpected gh output: ${JSON.stringify(out).slice(0, 200)}` } }
  } catch (error) {
    return toFailure(error)
  }
}

export type RepoDeps = FocusDeps & { ghRepo: (path: string) => Promise<GhRepoAnswer> }

export type RepoTracker = {
  /** The answer for the newest focus. An error is asked again, as it may be gone (a login, a
   *  remote added, a new workspace). */
  get(): Promise<RepoAnswer>
}

export function trackRepo(orca: OrcaWorkerApi, deps: RepoDeps): RepoTracker {
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
      return { ok: true, nameWithOwner: repo.nameWithOwner, url: repo.url, path, resolvedBy: focus.resolvedBy }
    } catch (error) {
      return hostFailed(error)
    }
  }

  // Resolves one focus; panels hear the answer when it differs from the last one they heard.
  async function settle(context: Promise<FocusContext | null>): Promise<void> {
    const mine = ++generation
    current = context.then(resolve, hostFailed)
    const answer = await current
    if (mine !== generation) return
    const key = JSON.stringify(answer)
    if (key === posted) return
    posted = key
    orca.panels.post('repo.changed', answer)
  }

  /** The answer for the newest focus, waiting out focus changes that land meanwhile. */
  async function latest(): Promise<RepoAnswer> {
    let answer: RepoAnswer
    let seen: Promise<RepoAnswer> | null
    do {
      seen = current
      answer = await seen!
    } while (seen !== current)
    return answer
  }

  orca.events.on('workspace.changed', ({ context }) => settle(Promise.resolve(context)))

  return {
    async get() {
      if (!current || !(await latest()).ok) void settle(orca.host.call('workspace.readContext'))
      return latest()
    }
  }
}
