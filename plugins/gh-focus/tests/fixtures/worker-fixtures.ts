// The worker tests' shared setup: a mock workspace list, the repo gh names for each folder, and
// the worker wired to them with no real gh.
import { mockHost } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Gh } from '../../src/worker/gh'
import * as main from '../../src/worker'
import type { GhRepoAnswer } from '../../src/worker/repo/repo'

export const noGh: Gh = async () => {
  throw new Error('no gh call expected')
}

export const workspaces = [
  { id: 'w-app', kind: 'worktree', name: 'main', path: '/code/app', branch: 'main', hostId: null },
  { id: 'w-lib', kind: 'worktree', name: 'main', path: '/code/lib', branch: 'main', hostId: null },
  { id: 'w-spike', kind: 'worktree', name: 'Spike', path: '/work/spike', branch: 'feature/spike', hostId: 'local' },
  { id: 'w-gl', kind: 'folder', name: 'gl', path: '/code/gl', branch: 'main', hostId: null },
  { id: 'w-out', kind: 'worktree', name: 'out', path: '/code/out', branch: 'main', hostId: null }
]
export const repos: Record<string, GhRepoAnswer> = {
  '/code/app': { ok: true, nameWithOwner: 'octo/app', url: 'https://github.com/octo/app' },
  '/work/spike': { ok: true, nameWithOwner: 'octo/app', url: 'https://github.com/octo/app' },
  '/code/gl': { ok: false, error: { code: 'not_a_repo', message: 'none of the git remotes point to a known GitHub host' } },
  '/code/out': { ok: false, error: { code: 'gh_logged_out', message: 'gh auth login' } }
}

export function repoWorker(gh: string[] = []) {
  return {
    default: (orca: OrcaWorkerApi) =>
      main.activateWith(orca, {
        gh: noGh,
        ghRepo: async (path) => {
          gh.push(path)
          return repos[path]
        },
        exists: () => true
      })
  }
}

/** A host whose focus is the workspace with this id in `workspaces`, or none. */
export function hostFocused(workspaceId: string | null) {
  const w = workspaces.find((w) => w.id === workspaceId)
  return mockHost({
    results: {
      'workspace.readContext': w ? { workspaceId: w.id, branch: w.branch, displayName: w.name, terminals: [] } : null,
      'workspace.list': { workspaces, truncated: false }
    }
  })
}
