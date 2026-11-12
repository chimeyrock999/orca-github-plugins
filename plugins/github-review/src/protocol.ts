// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

/** Why `repo.get` has no repo: finding the focused workspace, then asking gh in its folder. */
export type RepoErrorCode =
  | 'no_workspace'
  | 'workspace_not_found'
  | 'ambiguous_workspace'
  | 'remote_workspace'
  /** An Orca host call failed (workspace.readContext, workspace.list). */
  | 'host_failed'
  | 'not_a_repo'
  | 'gh_missing'
  | 'gh_logged_out'
  | 'gh_failed'

export type RepoError = {
  code: RepoErrorCode
  message: string
  /** The workspace folder, once one was found. */
  path?: string
  /** The workspaces that fit the focused context equally well (`ambiguous_workspace`). */
  candidates?: { id: string; name: string; path: string }[]
}

/** How the focused workspace was found: its branch and name alone, or one of its terminals. */
export type ResolvedBy = 'context' | 'terminal'

/** Errors are part of the answer: a thrown code that is not a host error code reaches the panel
 *  as `action_failed`. */
export type RepoAnswer =
  | { ok: true; nameWithOwner: string; path: string; resolvedBy: ResolvedBy }
  | { ok: false; error: RepoError }

declare module 'orca' {
  interface PluginRequests {
    /** The total the worker keeps in storage. */
    'counter.get': { output: { total: number } }
    /** Adds `by` to the stored total and answers the new total. */
    'counter.add': { input: { by: number }; output: { total: number } }
    /** The GitHub repo (`owner/name`) of the focused workspace. */
    'repo.get': { output: RepoAnswer }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after the total changes. */
    'counter.changed': { total: number }
    /** Posted to every open panel when the focused workspace's repo answer changes. */
    'repo.changed': RepoAnswer
  }
}
