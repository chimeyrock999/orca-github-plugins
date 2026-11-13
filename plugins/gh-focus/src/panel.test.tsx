// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses. The mock
// host's `requests` stand in for src/worker.ts.
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { read } from 'orca'
import { choices, setRepo } from './store'
import { failed, links, repoOk, runPage, runRows } from './fixtures'
import type { RunListInput } from './protocol'

function host(overrides: Record<string, unknown> = {}) {
  const asked: { name: string; input: unknown }[] = []
  const log = <I, O>(name: string, answer: (input: I) => O) => (input: I): O => {
    asked.push({ name, input })
    return answer(input)
  }
  const h = mockHost({
    requests: {
      'repo.get': log('repo.get', () => repoOk),
      'repo.links': log('repo.links', () => links()),
      'agent.find': log('agent.find', () => ({ ok: true, agent: { name: 'Claude Code', terminalId: 't1' } })),
      'runs.list': log('runs.list', (input: RunListInput) =>
        input.query ? runPage([runRows[2]]) : input.after === '2' ? runPage([runRows[2]], 33, null) : runPage(runRows, 33, '2')
      ),
      ...overrides
    }
  })
  return Object.assign(h, { asked })
}

const onRuns = { persisted: { plugin: { tab: 'runs' } } }

test('shows the repo and the Issues tab; with nothing linked, how to link one and no repo-wide list', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  assert.ok(view.find({ text: 'octo/app' }))
  assert.deepEqual(view.summary().filter((l) => l.startsWith('Tabs')), ['Tabs "GitHub": "Issues" selected'])
  assert.ok(view.summary().some((l) => /No issue linked to this workspace/.test(l)))
  assert.ok(view.find({ type: 'Code', text: 'orca reference add https://github.com/octo/app/issues/<number> --worktree current' }))
  assert.ok(view.find({ type: 'Button', text: 'Ask Claude Code to link' }))
  assert.ok(view.find({ type: 'Button', text: 'Tasks' }))
  // No search, filters, counts, pager or New issue: Orca's Tasks page has those.
  assert.equal(view.find({ label: 'Search issues' }), null)
  assert.equal(view.find({ label: 'Filter' }), null)
  assert.equal(view.find({ label: 'New issue' }), null)
  assert.equal(view.find({ text: 'Next' }), null)
  // Only the tab on screen asks; the Issues tab never asks for the branch's pull request.
  assert.deepEqual(h.asked, [
    { name: 'repo.get', input: undefined },
    { name: 'repo.links', input: {} },
    { name: 'agent.find', input: undefined }
  ])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('Next asks with the cursor the page gave, Previous goes back to the first page', async () => {
  const h = host()
  const view = await mount(panel, { host: h, ...onRuns })
  assert.equal(view.find({ text: 'Previous' })?.disabled, true)
  await view.press({ text: 'Next' })
  assert.deepEqual(h.asked.at(-1), { name: 'runs.list', input: { query: '', after: '2', filters: {}, scope: 'branch' } })
  assert.ok(view.find({ text: 'Page 2 of 2 · 33 total' }))
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  assert.equal(view.find({ text: 'Next' })?.disabled, true)
  await view.press({ text: 'Previous' })
  assert.deepEqual(h.asked.at(-1), { name: 'runs.list', input: { query: '', after: null, filters: {}, scope: 'branch' } })
  assert.ok(view.find({ text: 'Page 1 of 2 · 33 total' }))
  await view.unmount()
})

test('a search starts the list over from page 1', async () => {
  const h = host()
  const view = await mount(panel, { host: h, ...onRuns })
  await view.press({ text: 'Next' })
  await view.type({ label: 'Search runs' }, 'status:failure', { submit: true })
  assert.deepEqual(h.asked.at(-1), { name: 'runs.list', input: { query: 'status:failure', after: null, filters: {}, scope: 'branch' } })
  await view.unmount()
})

test('the toolbar opens the tab page of the repo', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  await view.select({ type: 'Tabs' }, 'pulls')
  await view.press({ label: 'Open on GitHub' })
  assert.deepEqual(h.callsOf('shell.openExternal'), [{ url: 'https://github.com/octo/app/pulls' }])
  await view.unmount()
})

test('each tab asks once when first shown and keeps what it found after', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  await view.select({ type: 'Tabs' }, 'runs')
  assert.ok(view.find({ text: '33 workflow runs' }))
  assert.ok(view.find({ text: /CI #295: Commit 40378fb pushed by kenji/ }))
  await view.select({ type: 'Tabs' }, 'issues')
  await view.select({ type: 'Tabs' }, 'runs')
  assert.deepEqual(h.asked.map((a) => a.name), ['repo.get', 'repo.links', 'agent.find', 'runs.list'])
  await view.unmount()
})

test('the tab persists across panel runs', async () => {
  const h = host()
  const view = await mount(panel, { host: h, persisted: { plugin: { tab: 'pulls' } } })
  assert.deepEqual(view.summary().filter((l) => l.startsWith('Tabs')), ['Tabs "GitHub": "Pull requests" selected'])
  // The Pull requests tab asks for what is linked, and the branch's pull request.
  assert.deepEqual(h.asked.slice(0, 2), [
    { name: 'repo.get', input: undefined },
    { name: 'repo.links', input: { branch: true } }
  ])
  assert.ok(view.summary().some((l) => /No pull request for this workspace/.test(l)))
  await view.unmount()
})

test('runs search passes the qualifiers on; a bad query shows how to search', async () => {
  const h = host({
    'runs.list': (input: RunListInput) =>
      input.query === 'flaky' ? failed('bad_query', 'GitHub cannot search runs by words.') : runPage([runRows[2]])
  })
  const view = await mount(panel, { host: h, ...onRuns })
  await view.type({ label: 'Search runs' }, 'flaky', { submit: true })
  assert.ok(view.summary().some((l) => /Search runs with qualifiers/.test(l)))
  await view.type({ label: 'Search runs' }, 'status:failure', { replace: true, submit: true })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  await view.unmount()
})

test('a failed list shows the problem with Retry, which asks again', async () => {
  let calls = 0
  const h = host({
    'runs.list': () => (++calls === 1 ? failed('rate_limited', 'API rate limit exceeded for user ID 1.') : runPage([runRows[0]]))
  })
  const view = await mount(panel, { host: h, ...onRuns })
  assert.ok(view.summary().some((l) => /GitHub rate limit reached/.test(l)))
  await view.press({ text: 'Retry' })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  await view.unmount()
})

test('a request that broke in the plugin says so; Retry stays, the only way to ask again', async () => {
  let calls = 0
  const h = host({
    'repo.get': () => {
      if (++calls === 1) throw hostError('action_failed', "Cannot read properties of undefined (reading 'nodes')")
      return repoOk
    }
  })
  const view = await mount(panel, { host: h })
  assert.ok(view.summary().some((l) => /Panel error/.test(l)))
  assert.ok(!view.summary().some((l) => /Orca did not answer/.test(l)))
  await view.press({ text: 'Retry' })
  assert.ok(view.find({ text: 'octo/app' }))
  await view.unmount()
})

test("Orca's rate limit says how long to wait, and Retry asks again", async () => {
  let calls = 0
  const h = host({
    'runs.list': () => {
      if (++calls === 1) throw hostError('rate_limited', 'plugin.request rate limited', 12_000)
      return runPage([runRows[0]])
    }
  })
  const view = await mount(panel, { host: h, ...onRuns })
  assert.ok(view.summary().some((l) => /Too many requests/.test(l)))
  assert.ok(view.find({ text: "Orca paces the panel's requests. Wait 12s, then press Retry." }))
  await view.press({ text: 'Retry' })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  await view.unmount()
})

test('a repo error shows its problem; Retry asks for the repo again', async () => {
  let loggedIn = false
  const h = host({ 'repo.get': () => (loggedIn ? repoOk : failed('gh_logged_out', 'To get started with GitHub CLI, please run:  gh auth login')) })
  const view = await mount(panel, { host: h })
  assert.ok(view.summary().some((l) => /gh is not logged in/.test(l)))
  loggedIn = true
  await view.press({ text: 'Retry' })
  assert.ok(view.find({ text: 'octo/app' }))
  assert.ok(view.summary().some((l) => /No issue linked to this workspace/.test(l)))
  await view.unmount()
})

test('no workspace focused is an empty state, not an error', async () => {
  const view = await mount(panel, { host: host({ 'repo.get': () => failed('no_workspace', 'No workspace is focused in Orca.') }) })
  assert.ok(view.summary().some((l) => /No workspace focused/.test(l)))
  await view.unmount()
})

test('a repo with no runs shows an empty state', async () => {
  const view = await mount(panel, { host: host({ 'runs.list': () => runPage([]) }), ...onRuns })
  assert.ok(view.summary().some((l) => /No workflow runs/.test(l)))
  assert.ok(view.find({ text: 'Page 1 of 1 · 0 total' }))
  await view.unmount()
})

test('another repo posted by the worker starts the tabs over', async () => {
  const h = host()
  const view = await mount(panel, { host: h, ...onRuns })
  await view.press({ text: 'Next' })
  await view.post('repo.changed', { ...repoOk, nameWithOwner: 'octo/lib', url: 'https://github.com/octo/lib', path: '/code/lib' })
  assert.ok(view.find({ text: 'octo/lib' }))
  assert.deepEqual(h.asked.at(-1), { name: 'runs.list', input: { query: '', after: null, filters: {}, scope: 'branch' } })
  // The same repo again changes nothing.
  const asked = h.asked.length
  await view.post('repo.changed', { ...repoOk, nameWithOwner: 'octo/lib', url: 'https://github.com/octo/lib', path: '/code/lib' })
  assert.equal(h.asked.length, asked)
  await view.unmount()
})

test('Refresh asks for the repo, what is linked and a free agent again', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  await view.press({ label: 'Refresh' })
  assert.deepEqual(h.asked.map((a) => a.name), ['repo.get', 'repo.links', 'agent.find', 'repo.get', 'repo.links', 'agent.find'])
  await view.unmount()
})

test('runs: workflow and status filters', async () => {
  const h = host({ 'workflows.list': { ok: true, workflows: [{ id: 7, name: 'CI' }, { id: 8, name: 'Release' }] } })
  const view = await mount(panel, { host: h, ...onRuns })
  await view.press({ label: 'Filter' })
  // Picked by name, sent by id: no name lookup on every page.
  await view.select({ label: 'Workflow' }, '8')
  await view.select({ label: 'Status' }, 'failure')
  assert.deepEqual(h.asked.at(-1), { name: 'runs.list', input: { query: '', after: null, filters: { workflow: '8', status: 'failure' }, scope: 'branch' } })
  assert.ok(view.find({ type: 'Button', text: '2' }))
  await view.press({ text: 'Clear filters' })
  assert.deepEqual((h.asked.at(-1)?.input as { filters: unknown }).filters, {})
  await view.unmount()
})

test('a filtered runs list reads with commas and the 1,000 cap', async () => {
  const view = await mount(panel, { host: host({ 'runs.list': () => runPage(runRows, 1234, '2', 1000) }), ...onRuns })
  assert.ok(view.find({ text: 'Page 1 of 34 · 1,234 total · first 1,000 shown' }))
  await view.unmount()
})

test('workflows of the old repo that answer after a repo change are dropped', async () => {
  const lib = { ...repoOk, nameWithOwner: 'octo/lib', url: 'https://github.com/octo/lib', path: '/code/lib' }
  const h = host({
    'workflows.list': async () => {
      // The focus moves to another repo while the workflows are on their way.
      setRepo(lib)
      return { ok: true, workflows: [{ id: 1, name: 'from-octo-app' }] }
    }
  })
  const view = await mount(panel, { host: h, ...onRuns })
  await view.press({ label: 'Filter' })
  assert.ok(view.find({ text: 'octo/lib' }))
  assert.deepEqual(read(choices).workflows, null)
  await view.unmount()
})

test('several workspaces match: pick one, it shows that repo, and Change workspace forgets it', async () => {
  const ambiguous = {
    ok: false as const,
    error: {
      code: 'ambiguous_workspace' as const,
      message: '2 workspaces are on main and named main.',
      candidates: [
        { id: 'w-app', name: 'main', path: '/code/app', project: 'app', branch: 'main' },
        { id: 'w-lib', name: 'main', path: '/code/lib', project: 'lib', branch: 'main' },
        { id: 'w-old', name: 'main', path: '/code/old-clone', project: null, branch: 'main' }
      ]
    }
  }
  const picks: string[] = []
  const h = host({
    'repo.get': () => ambiguous,
    'repo.pick': ({ path }: { path: string }) => (picks.push(path), { ...repoOk, resolvedBy: 'picked' as const }),
    'repo.unpick': () => ambiguous
  })
  const view = await mount(panel, { host: h })
  assert.ok(view.summary().some((l) => /Several workspaces match/.test(l)))
  // Each choice names its project and branch, with the folder under it; no project: the folder name.
  const items = view.findAll({ type: 'ListItem' })
  assert.deepEqual(items.map((i) => [i.props?.title, i.props?.description]), [
    ['app · main', '/code/app'],
    ['lib · main', '/code/lib'],
    ['old-clone', '/code/old-clone']
  ])
  await view.press({ type: 'ListItem', text: /^app · main/ })
  assert.deepEqual(picks, ['/code/app'])
  assert.ok(view.find({ text: 'octo/app' }))
  await view.press({ label: 'Change workspace' })
  assert.ok(view.find({ type: 'ListItem', text: /^lib · main/ }))
  await view.unmount()
})

test('choices that share a project and branch add their folder name; the others do not', async () => {
  const candidates = [
    { id: 'w-app', name: 'main', path: '/code/app', project: 'app', branch: 'main' },
    { id: 'w-app2', name: 'main', path: '/code/app-2/', project: 'app', branch: 'main' },
    { id: 'w-lib', name: 'main', path: '/code/lib', project: 'lib', branch: 'main' },
    { id: 'w-dev', name: 'main', path: '/code/app-dev', project: 'app', branch: 'dev' },
    { id: 'w-bare', name: 'main', path: '/code/bare', project: null, branch: 'main' },
    { id: 'w-bare2', name: 'main', path: '/code/bare2', project: null, branch: 'main' }
  ]
  const h = host({
    'repo.get': () => ({ ok: false as const, error: { code: 'ambiguous_workspace' as const, message: '6 workspaces match.', candidates } })
  })
  const view = await mount(panel, { host: h })
  assert.deepEqual(view.findAll({ type: 'ListItem' }).map((i) => [i.props?.title, i.props?.description]), [
    ['app · main (app)', '/code/app'],
    ['app · main (app-2)', '/code/app-2/'],
    ['lib · main', '/code/lib'],
    ['app · dev', '/code/app-dev'],
    ['bare', '/code/bare'],
    ['bare2', '/code/bare2']
  ])
  await view.unmount()
})
