// resolveFocus finds the focused workspace's workspace.list entry by the id readContext gives.
import { assert, test } from 'orca/testing'
import { resolveFocus, type FocusDeps, type WorkspaceEntry } from '../../../src/worker/repo/focus'

const app: WorkspaceEntry = { id: 'w-app', kind: 'worktree', name: 'main', path: '/code/app', branch: 'main', hostId: null }
const lib: WorkspaceEntry = { id: 'w-lib', kind: 'worktree', name: 'main', path: '/code/lib', branch: 'main', hostId: null }
const spike: WorkspaceEntry = { id: 'w-spike', kind: 'worktree', name: 'Spike: run gh', path: '/work/app/spike', branch: 'refs/heads/feature/spike', hostId: 'local' }
const remote: WorkspaceEntry = { id: 'w-remote', kind: 'worktree', name: 'remote', path: '/srv/svc', branch: 'dev', hostId: 'ssh-box' }

const deps = (missing: string[] = []): FocusDeps => ({ exists: (path) => !missing.includes(path) })

test('no focused workspace', async () => {
  const result = await resolveFocus(null, [app], deps())
  assert.equal(!result.ok && result.error.code, 'no_workspace')
})

test('the id in the context names the workspace', async () => {
  const result = await resolveFocus({ workspaceId: 'w-lib', branch: 'main', displayName: 'main', terminals: [{ id: 't1' }] }, [app, lib], deps())
  assert.deepEqual(result, { ok: true, workspace: lib })
})

test('the id wins over a branch and name that fit another workspace', async () => {
  const result = await resolveFocus({ workspaceId: 'w-app', branch: 'feature/spike', displayName: 'Spike: run gh', terminals: [] }, [app, spike], deps())
  assert.equal(result.ok && result.workspace.id, 'w-app')
})

test('an id workspace.list does not have is not found, without guessing from the branch', async () => {
  const result = await resolveFocus({ workspaceId: 'w-gone', branch: 'feature/spike', displayName: 'Spike: run gh', terminals: [] }, [app, spike], deps())
  assert.equal(!result.ok && result.error.code, 'workspace_not_found')
})

test('a context with no id is not found, even when one workspace has its branch and name', async () => {
  for (const workspaceId of [undefined, '']) {
    const result = await resolveFocus({ workspaceId, branch: 'feature/spike', displayName: 'Spike: run gh', terminals: [{ id: 't1' }] }, [app, spike], deps())
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.code, 'workspace_not_found')
    assert.match(result.error.message, /no id/)
  }
})

test('a workspace on another host is remote', async () => {
  const result = await resolveFocus({ workspaceId: 'w-remote', branch: 'dev', displayName: 'remote', terminals: [] }, [remote], deps())
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'remote_workspace')
  assert.equal(result.error.path, '/srv/svc')
})

test('a local workspace whose folder is missing is treated as remote', async () => {
  const result = await resolveFocus({ workspaceId: 'w-spike', branch: 'feature/spike', displayName: 'Spike: run gh', terminals: [] }, [spike], deps(['/work/app/spike']))
  assert.equal(!result.ok && result.error.code, 'remote_workspace')
})
