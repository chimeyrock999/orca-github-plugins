// resolveFocus matches the focused workspace's context to a workspace.list entry.
import { assert, test } from 'orca/testing'
import { pickKey, resolveFocus, type FocusDeps, type WorkspaceEntry } from './focus'

const app: WorkspaceEntry = { id: 'w-app', kind: 'worktree', name: 'main', project: 'app', path: '/code/app', branch: 'main', hostId: null }
const lib: WorkspaceEntry = { id: 'w-lib', kind: 'worktree', name: 'main', project: 'lib', path: '/code/lib', branch: 'main', hostId: null }
const spike: WorkspaceEntry = {
  id: 'w-spike',
  kind: 'worktree',
  name: 'Spike: run gh',
  project: 'app',
  path: '/work/app/spike',
  branch: 'refs/heads/feature/spike',
  hostId: 'local'
}
const remote: WorkspaceEntry = { id: 'w-remote', kind: 'worktree', name: 'remote', project: 'svc', path: '/srv/svc', branch: 'dev', hostId: 'ssh-box' }

function deps(paths: Record<string, string> = {}, missing: string[] = []): FocusDeps & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    terminalPath: async (id) => {
      asked.push(id)
      return paths[id] ?? null
    },
    exists: (path) => !missing.includes(path)
  }
}

test('no focused workspace', async () => {
  const result = await resolveFocus(null, [app], deps())
  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.error.code, 'no_workspace')
})

test('one workspace on the branch with the name resolves from the context alone', async () => {
  const d = deps()
  const result = await resolveFocus({ branch: 'feature/spike', displayName: 'Spike: run gh', terminals: [{ id: 't1' }] }, [app, spike], d)
  assert.deepEqual(result, { ok: true, workspace: spike, resolvedBy: 'context' })
  assert.deepEqual(d.asked, [])
})

test('strips refs/heads/ on both sides', async () => {
  const result = await resolveFocus({ branch: 'refs/heads/feature/spike', displayName: 'Spike: run gh', terminals: [] }, [spike], deps())
  assert.equal(result.ok && result.workspace.id, 'w-spike')
})

test('two repos on main: a focused terminal breaks the tie', async () => {
  const d = deps({ t2: '/code/lib' })
  const result = await resolveFocus({ branch: 'main', displayName: 'main', terminals: [{ id: 't1' }, { id: 't2' }] }, [app, lib], d)
  assert.deepEqual(result, { ok: true, workspace: lib, resolvedBy: 'terminal' })
  assert.deepEqual(d.asked, ['t1', 't2'])
})

test('two repos on main and no terminal answer: ambiguous, with the candidates and their project and branch', async () => {
  const bare: WorkspaceEntry = { id: 'w-bare', kind: 'folder', name: 'main', path: '/code/bare', branch: 'refs/heads/main', hostId: null }
  const result = await resolveFocus({ branch: 'main', displayName: 'main', terminals: [{ id: 't1' }] }, [app, lib, spike, bare], deps())
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'ambiguous_workspace')
  assert.deepEqual(result.error.candidates, [
    { id: 'w-app', name: 'main', path: '/code/app', project: 'app', branch: 'main' },
    { id: 'w-lib', name: 'main', path: '/code/lib', project: 'lib', branch: 'main' },
    { id: 'w-bare', name: 'main', path: '/code/bare', project: null, branch: 'main' }
  ])
})

test('a terminal path outside workspace.list does not resolve', async () => {
  const result = await resolveFocus({ branch: 'main', displayName: 'main', terminals: [{ id: 't1' }] }, [app, lib], deps({ t1: '/elsewhere' }))
  assert.equal(!result.ok && result.error.code, 'ambiguous_workspace')
})

test('a name that matches nothing falls back to the terminal', async () => {
  const result = await resolveFocus({ branch: 'feature/spike', displayName: 'Renamed', terminals: [{ id: 't1' }] }, [spike], deps({ t1: '/work/app/spike' }))
  assert.deepEqual(result, { ok: true, workspace: spike, resolvedBy: 'terminal' })
})

test('nothing matches', async () => {
  const result = await resolveFocus({ branch: 'gone', displayName: 'gone', terminals: [] }, [app], deps())
  assert.equal(!result.ok && result.error.code, 'workspace_not_found')
})

test('a workspace on another host is remote', async () => {
  const result = await resolveFocus({ branch: 'dev', displayName: 'remote', terminals: [] }, [remote], deps())
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'remote_workspace')
  assert.equal(result.error.path, '/srv/svc')
})

test('a local workspace whose folder is missing is treated as remote', async () => {
  const result = await resolveFocus({ branch: 'feature/spike', displayName: 'Spike: run gh', terminals: [] }, [spike], deps({}, ['/work/app/spike']))
  assert.equal(!result.ok && result.error.code, 'remote_workspace')
})

test('with several matches, a terminal in another workspace does not override the context', async () => {
  const result = await resolveFocus({ branch: 'main', displayName: 'main', terminals: [{ id: 't1' }] }, [app, lib, spike], deps({ t1: '/work/app/spike' }))
  assert.equal(!result.ok && result.error.code, 'ambiguous_workspace')
})

test('a trailing slash on either path still matches', async () => {
  const result = await resolveFocus({ branch: 'main', displayName: 'main', terminals: [{ id: 't1' }] }, [app, lib], deps({ t1: '/code/lib/' }))
  assert.equal(result.ok && result.workspace.id, 'w-lib')
})

test('a focused terminal wins over a stored pick: the pick is shared by every same-named clone', async () => {
  const d = { ...deps({ t1: '/code/app' }), picked: async () => '/code/lib/' }
  const result = await resolveFocus({ branch: 'main', displayName: 'main', terminals: [{ id: 't1' }] }, [app, lib], d)
  assert.deepEqual(result, { ok: true, workspace: app, resolvedBy: 'terminal' })
})

test('a stored pick settles two repos on main when no terminal tells', async () => {
  const d = { ...deps(), picked: async () => '/code/lib/' }
  const result = await resolveFocus({ branch: 'main', displayName: 'main', terminals: [{ id: 't1' }] }, [app, lib], d)
  assert.deepEqual(result, { ok: true, workspace: lib, resolvedBy: 'picked' })
  assert.deepEqual(d.asked, ['t1'])
})

test('a pick that is no longer among the matches is ignored', async () => {
  const d = { ...deps(), picked: async () => '/code/removed' }
  const result = await resolveFocus({ branch: 'main', displayName: 'main', terminals: [] }, [app, lib], d)
  assert.equal(!result.ok && result.error.code, 'ambiguous_workspace')
})

test('a pick is not asked for when the context fits one workspace', async () => {
  let asked = 0
  const d = { ...deps(), picked: async () => (asked++, '/code/lib') }
  const result = await resolveFocus({ branch: 'feature/spike', displayName: 'Spike: run gh', terminals: [] }, [app, lib, spike], d)
  assert.equal(result.ok && result.resolvedBy, 'context')
  assert.equal(asked, 0)
})

test('a stored pick is asked for with the matches, so the key can name their projects', async () => {
  let seen: WorkspaceEntry[] = []
  const d = { ...deps(), picked: async (_: unknown, matches: WorkspaceEntry[]) => ((seen = matches), '/code/lib') }
  await resolveFocus({ branch: 'main', displayName: 'main', terminals: [] }, [app, lib, spike], d)
  assert.deepEqual(seen, [app, lib])
})

test('the pick key holds the branch, the name and the sorted distinct projects of the matches', () => {
  const context = { branch: 'refs/heads/main', displayName: 'main', terminals: [] }
  const appClone: WorkspaceEntry = { ...app, id: 'w-app2', path: '/code/app2' }
  assert.equal(pickKey(context, [lib, app, appClone]), 'main\nmain\n["app","lib"]')
  // Orca's project id is preferred over the repo name, which two repos may share.
  assert.equal(pickKey(context, [{ ...app, projectId: 'p-1' }, { ...lib, projectId: 'p-2', project: 'app' }]), 'main\nmain\n["p-1","p-2"]')
  // A workspace without a project still counts, as an empty name.
  assert.equal(pickKey(context, [app, { ...lib, project: null }]), 'main\nmain\n["","app"]')
})

test('project names with commas cannot make two project sets share a key', () => {
  const context = { branch: 'main', displayName: 'main', terminals: [] }
  const one = pickKey(context, [{ ...app, project: 'a,b' }, { ...lib, project: 'c' }])
  const two = pickKey(context, [{ ...app, project: 'a' }, { ...lib, project: 'b,c' }])
  assert.notEqual(one, two)
  assert.equal(one, 'main\nmain\n["a,b","c"]')
})
