// Finds the focused workspace's folder. workspace.readContext gives only its branch and name, and
// workspace.list gives folders, so the two are matched. Orca names root clones after their branch,
// so repos on `main` look alike; then a focused terminal decides, through the Orca CLI.
import type { PanelError, ResolvedBy } from './protocol'

export type WorkspaceEntry = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  project?: string | null
  path: string
  branch: string | null
  hostId: string | null
}

export type FocusContext = {
  branch: string
  displayName: string
  terminals: { id: string; title?: string }[]
}

export type FocusDeps = {
  /** The workspace folder a terminal runs in, or null when that cannot be told. */
  terminalPath: (terminalId: string) => Promise<string | null>
  exists: (path: string) => boolean
}

export type FocusResult =
  | { ok: true; workspace: WorkspaceEntry; resolvedBy: ResolvedBy }
  | { ok: false; error: PanelError }

export function stripRef(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

/** This machine is hostId null or 'local'; any other host's folders are out of reach of gh here. */
function isLocal(workspace: WorkspaceEntry, exists: FocusDeps['exists']): boolean {
  return (workspace.hostId == null || workspace.hostId === 'local') && exists(workspace.path)
}

/** Folder paths as Orca and its CLI may spell them: with or without a trailing slash. */
function samePath(a: string, b: string): boolean {
  const trim = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p)
  return trim(a) === trim(b)
}

async function byTerminal(
  context: FocusContext,
  workspaces: WorkspaceEntry[],
  terminalPath: FocusDeps['terminalPath']
): Promise<WorkspaceEntry | null> {
  for (const terminal of context.terminals) {
    const path = await terminalPath(terminal.id)
    const workspace = path ? workspaces.find((w) => samePath(w.path, path)) : undefined
    if (workspace) return workspace
  }
  return null
}

export async function resolveFocus(
  context: FocusContext | null,
  workspaces: WorkspaceEntry[],
  deps: FocusDeps
): Promise<FocusResult> {
  if (!context) return { ok: false, error: { code: 'no_workspace', message: 'No workspace is focused in Orca.' } }

  const branch = stripRef(context.branch)
  const matches = workspaces.filter((w) => stripRef(w.branch ?? '') === branch && w.name === context.displayName)
  let found: { workspace: WorkspaceEntry; resolvedBy: ResolvedBy } | null = null
  if (matches.length === 1) {
    found = { workspace: matches[0], resolvedBy: 'context' }
  } else {
    // A terminal only picks among the matches when there are some; with none it may name any.
    const workspace = await byTerminal(context, matches.length > 1 ? matches : workspaces, deps.terminalPath)
    if (workspace) found = { workspace, resolvedBy: 'terminal' }
  }

  if (!found && matches.length > 1) {
    return {
      ok: false,
      error: {
        code: 'ambiguous_workspace',
        message: `${matches.length} workspaces are on ${branch} and named ${context.displayName}.`,
        candidates: matches.map((w) => ({ id: w.id, name: w.name, path: w.path }))
      }
    }
  }
  if (!found) {
    return {
      ok: false,
      error: { code: 'workspace_not_found', message: `No workspace is on ${branch} and named ${context.displayName}.` }
    }
  }
  if (!isLocal(found.workspace, deps.exists)) {
    return {
      ok: false,
      error: { code: 'remote_workspace', message: 'The workspace is not on this machine.', path: found.workspace.path }
    }
  }
  return { ok: true, ...found }
}
