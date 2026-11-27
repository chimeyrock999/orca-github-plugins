// Finds the focused workspace's folder: workspace.readContext names the workspace by the id
// workspace.list gives (host API 1.7), and that row is the answer.
import type { PanelError } from '../../shared/protocol'

export type WorkspaceEntry = {
  id: string
  kind: 'worktree' | 'folder'
  name: string
  path: string
  branch: string | null
  hostId: string | null
}

export type FocusContext = {
  /** The id workspace.list gives the focused workspace. Orca leaves it out only for an id too long
   *  to pass to plugins. */
  workspaceId?: string
  branch: string
  displayName: string
  terminals: { id: string; title?: string }[]
}

export type FocusDeps = {
  exists: (path: string) => boolean
}

export type FocusResult = { ok: true; workspace: WorkspaceEntry } | { ok: false; error: PanelError }

/** This machine is hostId null or 'local'; any other host's folders are out of reach of gh here. */
function isLocal(workspace: WorkspaceEntry, exists: FocusDeps['exists']): boolean {
  return (workspace.hostId == null || workspace.hostId === 'local') && exists(workspace.path)
}

export function resolveFocus(context: FocusContext | null, workspaces: WorkspaceEntry[], deps: FocusDeps): FocusResult {
  if (!context) return { ok: false, error: { code: 'no_workspace', message: 'No workspace is focused in Orca.' } }
  if (!context.workspaceId) {
    return { ok: false, error: { code: 'workspace_not_found', message: `Orca gave no id for the focused workspace ${context.displayName}.` } }
  }
  const workspace = workspaces.find((w) => w.id === context.workspaceId)
  if (!workspace) return { ok: false, error: { code: 'workspace_not_found', message: `Orca did not list the focused workspace ${context.displayName}.` } }
  if (!isLocal(workspace, deps.exists)) {
    return { ok: false, error: { code: 'remote_workspace', message: 'The workspace is not on this machine.', path: workspace.path } }
  }
  return { ok: true, workspace }
}
