// The person's pick among workspaces that share the focused branch and name: its key (branch, name
// and the projects of the matches), old keys, and storage, through src/worker.ts over a mock host.
import { assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import type { OrcaWorkerApi } from 'orca/worker'
import { repoWorker, workspaces } from './worker-fixtures'

test('repo.pick settles an ambiguous focus, keeps the pick in storage, and repo.unpick forgets it', async () => {
  const host = mockHost({
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
      'workspace.list': { workspaces, truncated: false }
    }
  })
  const worker = await mountWorker(repoWorker(), { host })
  const first = await worker.request('repo.get')
  assert.equal(!first.ok && first.error.code, 'ambiguous_workspace')

  const picked = await worker.request('repo.pick', { path: '/code/app' })
  assert.equal(picked.ok && picked.resolvedBy, 'picked')
  assert.equal(picked.ok && picked.nameWithOwner, 'octo/app')
  assert.deepEqual(host.data().storage, { picks: { 'main\nmain\napp,lib': '/code/app' } })
  // The same focus later still resolves by the pick.
  await worker.emit('workspace.changed', { context: { branch: 'main', displayName: 'main', terminals: [] } })
  assert.equal(((await worker.request('repo.get')) as { resolvedBy?: string }).resolvedBy, 'picked')

  const forgot = await worker.request('repo.unpick')
  assert.equal(!forgot.ok && forgot.error.code, 'ambiguous_workspace')
  assert.deepEqual(host.data().storage, { picks: {} })
  await worker.deactivate()
})

test('a pick stored by an earlier run is used, and a stale one is ignored', async () => {
  const focused = { branch: 'main', displayName: 'main', terminals: [] }
  const host = mockHost({
    storage: { picks: { 'main\nmain\napp,lib': '/code/app' } },
    results: { 'workspace.readContext': focused, 'workspace.list': { workspaces, truncated: false } }
  })
  const worker = await mountWorker(repoWorker(), { host })
  const answer = await worker.request('repo.get')
  assert.equal(answer.ok && answer.path, '/code/app')
  await worker.deactivate()

  const stale = mockHost({
    storage: { picks: { 'main\nmain\napp,lib': '/code/gone' } },
    results: { 'workspace.readContext': focused, 'workspace.list': { workspaces, truncated: false } }
  })
  const again = await mountWorker(repoWorker(), { host: stale })
  const ambiguous = await again.request('repo.get')
  assert.equal(!ambiguous.ok && ambiguous.error.code, 'ambiguous_workspace')
  await again.deactivate()
})

test('a clone of another repo joining the matches asks again, and the pick comes back when it leaves', async () => {
  const focused = { branch: 'main', displayName: 'main', terminals: [] }
  const other = { id: 'w-docs', kind: 'worktree', name: 'main', project: 'docs', path: '/code/docs', branch: 'main', hostId: null }
  let listed = workspaces
  const host = mockHost({
    storage: { picks: { 'main\nmain\napp,lib': '/code/app' } },
    results: { 'workspace.readContext': focused, 'workspace.list': () => ({ workspaces: listed, truncated: false }) }
  })
  const worker = await mountWorker(repoWorker(), { host })
  assert.equal(((await worker.request('repo.get')) as { resolvedBy?: string }).resolvedBy, 'picked')

  listed = [...workspaces, other]
  await worker.emit('workspace.changed', { context: focused })
  const asked = await worker.request('repo.get')
  assert.equal(!asked.ok && asked.error.code, 'ambiguous_workspace')
  assert.deepEqual(!asked.ok && asked.error.candidates?.map((c) => c.project), ['app', 'lib', 'docs'])
  // A pick in the larger set is stored under its own key; the earlier one stays for the smaller set.
  const picked = await worker.request('repo.pick', { path: '/code/app' })
  assert.equal(picked.ok && picked.resolvedBy, 'picked')
  assert.deepEqual(host.data().storage, { picks: { 'main\nmain\napp,lib': '/code/app', 'main\nmain\napp,docs,lib': '/code/app' } })

  listed = workspaces
  await worker.emit('workspace.changed', { context: focused })
  assert.equal(((await worker.request('repo.get')) as { resolvedBy?: string }).resolvedBy, 'picked')
  await worker.deactivate()
})

test('a pick under the old branch-and-name key is dropped from storage once', async () => {
  const focused = { branch: 'main', displayName: 'main', terminals: [] }
  const host = mockHost({
    storage: { picks: { 'main\nmain': '/code/app', 'dev\napi\napi': '/code/api' } },
    results: { 'workspace.readContext': focused, 'workspace.list': { workspaces, truncated: false } }
  })
  const worker = await mountWorker(repoWorker(), { host })
  const answer = await worker.request('repo.get')
  assert.equal(!answer.ok && answer.error.code, 'ambiguous_workspace')
  assert.deepEqual(host.data().storage, { picks: { 'dev\napi\napi': '/code/api' } })
  await worker.emit('workspace.changed', { context: focused })
  await worker.request('repo.get')
  assert.equal(host.callsOf('storage.set').length, 1)
  await worker.deactivate()
})

test('a pick made while old keys are being dropped is kept', async () => {
  const focused = { branch: 'main', displayName: 'main', terminals: [] }
  // The store answers the first read late, so the pick runs while old keys are being dropped.
  let stored: Record<string, unknown> = { picks: { 'main\nmain': '/code/lib' } }
  let reads = 0
  const host = mockHost({
    results: {
      'workspace.readContext': focused,
      'workspace.list': { workspaces, truncated: false },
      'storage.get': async ({ key }: { key: string }) => {
        const value = stored[key] ?? null
        if (++reads === 1) await new Promise((r) => setTimeout(r, 20))
        return { value }
      },
      'storage.set': ({ key, value }: { key: string; value: unknown }) => ((stored = { ...stored, [key]: value }), { ok: true })
    }
  })
  const worker = await mountWorker(repoWorker(), { host })
  const [, picked] = await Promise.all([worker.request('repo.get'), worker.request('repo.pick', { path: '/code/app' })])
  assert.equal(picked.ok && picked.resolvedBy, 'picked')
  assert.deepEqual(stored, { picks: { 'main\nmain\napp,lib': '/code/app' } })
  await worker.deactivate()
})

test('repo.pick stores and reads the pick for the same workspace list, even when the next list differs', async () => {
  // Every workspace.list answer has one more clone of another repo on main, so two lists never agree.
  let listed = 0
  const host = mockHost({
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
      'workspace.list': () => {
        listed++
        const extra = { id: `w-x${listed}`, kind: 'worktree', name: 'main', project: `x${listed}`, path: `/code/x${listed}`, branch: 'main', hostId: null }
        return { workspaces: [...workspaces, extra], truncated: false }
      }
    }
  })
  const worker = await mountWorker(repoWorker(), { host })
  const picked = await worker.request('repo.pick', { path: '/code/app' })
  assert.equal(picked.ok && picked.resolvedBy, 'picked')
  await worker.deactivate()
})

test("the pick key uses Orca's project id over the repo name when workspace.list has it", async () => {
  const host = mockHost({
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
      'workspace.list': { workspaces, truncated: false }
    }
  })
  // The installed Orca's host API has no projectId yet (host API 1.7), and the mock host drops what
  // the API does not declare, so the rows get it here, as a newer Orca sends them.
  const withIds = {
    default: (orca: OrcaWorkerApi) => {
      const call = (async (method: string, params?: unknown) => {
        const result = await (orca.host.call as (m: string, p?: unknown) => Promise<unknown>)(method, params)
        if (method !== 'workspace.list') return result
        const list = result as { workspaces: { project?: string | null }[]; truncated: boolean }
        return { ...list, workspaces: list.workspaces.map((w) => ({ ...w, projectId: `id-${w.project}` })) }
      }) as OrcaWorkerApi['host']['call']
      return repoWorker().default({ ...orca, host: { ...orca.host, call } })
    }
  }
  const worker = await mountWorker(withIds, { host })
  const picked = await worker.request('repo.pick', { path: '/code/app' })
  assert.equal(picked.ok && picked.resolvedBy, 'picked')
  assert.deepEqual(host.data().storage, { picks: { 'main\nmain\nid-app,id-lib': '/code/app' } })
  await worker.deactivate()
})

test('a failed write back of dropped old keys still resolves; a failed pick write answers its code', async () => {
  const host = mockHost({
    storage: { picks: { 'main\nmain': '/code/app' } },
    results: {
      'workspace.readContext': { branch: 'main', displayName: 'main', terminals: [] },
      'workspace.list': { workspaces, truncated: false },
      'storage.set': () => {
        throw hostError('too_large', 'storage full')
      }
    }
  })
  const worker = await mountWorker(repoWorker(), { host })
  const answer = await worker.request('repo.get')
  assert.equal(!answer.ok && answer.error.code, 'ambiguous_workspace')
  const picked = await worker.request('repo.pick', { path: '/code/app' })
  assert.deepEqual(picked, { ok: false, error: { code: 'too_large', message: 'storage full' } })
  // The refused write is the pick under the new key.
  const writes = host.callsOf('storage.set') as { key: string; value: unknown }[]
  assert.deepEqual(writes.at(-1), { key: 'picks', value: { 'main\nmain\napp,lib': '/code/app' } })
  await worker.deactivate()
})
