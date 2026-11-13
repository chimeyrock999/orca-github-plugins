// The worker tests' shared setup: a mock workspace list, the repo gh names for each folder, and
// the worker wired to them with no real gh or Orca CLI.
import { mockHost } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Gh } from '../../src/worker/gh'
import * as main from '../../src/worker'
import type { GhRepoAnswer } from '../../src/worker/repo/repo'

export const noGh: Gh = async () => {
  throw new Error('no gh call expected')
}

export const workspaces = [
  { id: 'w-app', kind: 'worktree', name: 'main', project: 'app', path: '/code/app', branch: 'main', hostId: null },
  { id: 'w-lib', kind: 'worktree', name: 'main', project: 'lib', path: '/code/lib', branch: 'main', hostId: null },
  { id: 'w-spike', kind: 'worktree', name: 'Spike', project: 'app', path: '/work/spike', branch: 'feature/spike', hostId: 'local' },
  { id: 'w-gl', kind: 'folder', name: 'gl', project: 'gl', path: '/code/gl', branch: 'main', hostId: null },
  { id: 'w-out', kind: 'worktree', name: 'out', project: 'out', path: '/code/out', branch: 'main', hostId: null }
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
        terminalPath: async () => null,
        exists: () => true
      })
  }
}

export function hostFocused(context: { branch: string; displayName: string } | null) {
  return mockHost({
    results: {
      'workspace.readContext': context && { ...context, terminals: [] },
      'workspace.list': { workspaces, truncated: false }
    }
  })
}
