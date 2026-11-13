// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses. The mock
// host's `requests` stand in for src/worker.ts.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { KindView } from './views'
import { read } from 'orca'
import { choices, setRepo } from './store'
import { failed, issueRows, itemPage, pullRows, repoOk, runPage, runRows } from './fixtures'
import type { ItemListInput, RunListInput } from './protocol'

function host(overrides: Record<string, unknown> = {}) {
  const asked: { name: string; input: unknown }[] = []
  const log = <I, O>(name: string, answer: (input: I) => O) => (input: I): O => {
    asked.push({ name, input })
    return answer(input)
  }
  const h = mockHost({
    requests: {
      'repo.get': log('repo.get', () => repoOk),
      'issues.list': log('issues.list', (input: ItemListInput) =>
        input.after === 'p2' ? itemPage(issueRows(12, 90), 42, null) : itemPage(issueRows(30), 42, 'p2', 5)
      ),
      'pulls.list': log('pulls.list', () => itemPage(pullRows, 2, null, 1)),
      'runs.list': log('runs.list', (input: RunListInput) => (input.query ? runPage([runRows[2]]) : runPage(runRows))),
      ...overrides
    }
  })
  return Object.assign(h, { asked })
}

test('shows the repo, the Issues tab and its first page with counts', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  assert.ok(view.find({ text: 'octo/app' }))
  assert.deepEqual(view.summary().filter((l) => l.startsWith('Tabs')), ['Tabs "GitHub": "Issues" selected'])
  assert.equal(view.findAll({ type: 'ListItem' }).length, 30)
  assert.deepEqual(view.findAll({ type: 'Badge' }).slice(0, 2).map((b) => b.text), ['42', '5'])
  assert.ok(view.find({ text: 'Page 1 of 2 · 42 total' }))
  // Only the tab on screen loads.
  assert.deepEqual(h.asked.map((a) => a.name), ['repo.get', 'issues.list'])
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
})

test('Next asks with the cursor the page gave, Previous goes back to the first page', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  assert.equal(view.find({ text: 'Previous' })?.disabled, true)
  await view.press({ text: 'Next' })
  assert.deepEqual(h.asked.at(-1), { name: 'issues.list', input: { state: 'open', query: '', after: 'p2', filters: {}, sort: 'created-desc', withCounts: false } })
  assert.ok(view.find({ text: 'Page 2 of 2 · 42 total' }))
  assert.equal(view.findAll({ type: 'ListItem' }).length, 12)
  assert.equal(view.find({ text: 'Next' })?.disabled, true)
  await view.press({ text: 'Previous' })
  assert.deepEqual(h.asked.at(-1), { name: 'issues.list', input: { state: 'open', query: '', after: null, filters: {}, sort: 'created-desc', withCounts: false } })
  assert.ok(view.find({ text: 'Page 1 of 2 · 42 total' }))
  await view.unmount()
})

test('search and Closed start the list over from page 1', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  await view.press({ text: 'Next' })
  await view.type({ label: 'Search issues' }, 'csv', { submit: true })
  assert.deepEqual(h.asked.at(-1), { name: 'issues.list', input: { state: 'open', query: 'csv', after: null, filters: {}, sort: 'created-desc', withCounts: true } })
  await view.press({ type: 'Button', text: 'Closed' })
  assert.deepEqual(h.asked.at(-1), { name: 'issues.list', input: { state: 'closed', query: 'csv', after: null, filters: {}, sort: 'created-desc', withCounts: true } })
  await view.unmount()
})

test('a row opens its detail, Back returns to the same page, and Open on GitHub opens the row', async () => {
  const h = host()
  const view = await mount(panel, { host: h, persisted: { plugin: { tab: 'pulls' } } })
  await view.press({ type: 'ListItem', text: /Fix token refresh loop/ })
  assert.ok(view.find({ text: '← Back to pull requests' }))
  assert.ok(view.find({ type: 'Text', text: 'Fix token refresh loop' }))
  await view.press({ text: 'Open on GitHub' })
  assert.deepEqual(h.callsOf('shell.openExternal'), [{ url: 'https://github.com/octo/app/pull/124' }])
  await view.press({ text: '← Back to pull requests' })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 2)
  assert.deepEqual(view.refusals, [])
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

test('each tab loads once when first shown and keeps its page after', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  await view.select({ type: 'Tabs' }, 'runs')
  assert.ok(view.find({ text: '3 workflow runs' }))
  assert.ok(view.find({ text: /CI #295: Commit 40378fb pushed by kenji/ }))
  await view.select({ type: 'Tabs' }, 'issues')
  await view.select({ type: 'Tabs' }, 'runs')
  assert.deepEqual(h.asked.map((a) => a.name), ['repo.get', 'issues.list', 'runs.list'])
  await view.unmount()
})

test('the tab persists across panel runs', async () => {
  const h = host()
  const view = await mount(panel, { host: h, persisted: { plugin: { tab: 'pulls' } } })
  assert.deepEqual(view.summary().filter((l) => l.startsWith('Tabs')), ['Tabs "GitHub": "Pull requests" selected'])
  assert.deepEqual(h.asked.map((a) => a.name), ['repo.get', 'pulls.list'])
  await view.unmount()
})

test('runs search passes the qualifiers on; a bad query shows how to search', async () => {
  const h = host({
    'runs.list': (input: RunListInput) =>
      input.query === 'flaky' ? failed('bad_query', 'GitHub cannot search runs by words.') : runPage([runRows[2]])
  })
  const view = await mount(panel, { host: h, persisted: { plugin: { tab: 'runs' } } })
  await view.type({ label: 'Search runs' }, 'flaky', { submit: true })
  assert.ok(view.summary().some((l) => /Search runs with qualifiers/.test(l)))
  await view.type({ label: 'Search runs' }, 'status:failure', { replace: true, submit: true })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  await view.unmount()
})

test('a failed list shows the problem with Retry, which asks again', async () => {
  let calls = 0
  const h = host({
    'issues.list': () => (++calls === 1 ? failed('rate_limited', 'API rate limit exceeded for user ID 1.') : itemPage(issueRows(1), 1, null))
  })
  const view = await mount(panel, { host: h })
  assert.ok(view.summary().some((l) => /GitHub rate limit reached/.test(l)))
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
  assert.equal(view.findAll({ type: 'ListItem' }).length, 30)
  await view.unmount()
})

test('no workspace focused is an empty state, not an error', async () => {
  const view = await mount(panel, { host: host({ 'repo.get': () => failed('no_workspace', 'No workspace is focused in Orca.') }) })
  assert.ok(view.summary().some((l) => /No workspace focused/.test(l)))
  await view.unmount()
})

test('an empty repo shows empty states', async () => {
  const view = await mount(panel, { host: host({ 'issues.list': () => itemPage([], 0, null) }) })
  assert.ok(view.summary().some((l) => /No issues/.test(l)))
  assert.ok(view.find({ text: 'Page 1 of 1 · 0 total' }))
  await view.unmount()
})

test('another repo posted by the worker starts the lists over', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  await view.press({ text: 'Next' })
  await view.post('repo.changed', { ...repoOk, nameWithOwner: 'octo/lib', url: 'https://github.com/octo/lib', path: '/code/lib' })
  assert.ok(view.find({ text: 'octo/lib' }))
  assert.deepEqual(h.asked.at(-1), { name: 'issues.list', input: { state: 'open', query: '', after: null, filters: {}, sort: 'created-desc', withCounts: true } })
  // The same repo again changes nothing.
  const asked = h.asked.length
  await view.post('repo.changed', { ...repoOk, nameWithOwner: 'octo/lib', url: 'https://github.com/octo/lib', path: '/code/lib' })
  assert.equal(h.asked.length, asked)
  await view.unmount()
})

test('Refresh asks for the repo and reloads the page on screen', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  await view.press({ label: 'Refresh' })
  assert.deepEqual(h.asked.map((a) => a.name), ['repo.get', 'issues.list', 'repo.get', 'issues.list'])
  await view.unmount()
})

test('filters: author and label narrow the list, the button counts them, Clear removes them', async () => {
  const h = host({ 'labels.list': { ok: true, names: ['bug', 'good first issue'] } })
  const view = await mount(panel, { host: h })
  await view.press({ label: 'Filter' })
  // Opening the filter asks for the repo's labels once.
  assert.deepEqual(h.callsOf('plugin.request').filter((c) => (c as { name: string }).name === 'labels.list').length, 1)
  await view.select({ label: 'Label' }, 'good first issue')
  assert.deepEqual(h.asked.at(-1), {
    name: 'issues.list',
    input: { state: 'open', query: '', after: null, filters: { label: 'good first issue' }, sort: 'created-desc', withCounts: true }
  })
  await view.type({ label: 'Author' }, 'mai-t', { submit: true })
  assert.deepEqual((h.asked.at(-1)?.input as { filters: unknown }).filters, { label: 'good first issue', author: 'mai-t' })
  assert.ok(view.find({ type: 'Button', text: '2' }))
  await view.press({ text: 'Clear filters' })
  assert.deepEqual((h.asked.at(-1)?.input as { filters: unknown }).filters, {})
  assert.equal(view.valueOf({ label: 'Author' }), '')
  assert.ok(view.find({ label: 'Filter' }))
  await view.unmount()
})

test('sort: the chosen order is asked for from page 1', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  await view.press({ text: 'Next' })
  await view.press({ label: 'Sort: Newest' })
  await view.select({ label: 'Sort' }, 'comments-desc')
  assert.deepEqual(h.asked.at(-1), {
    name: 'issues.list',
    input: { state: 'open', query: '', after: null, filters: {}, sort: 'comments-desc', withCounts: true }
  })
  assert.ok(view.find({ label: 'Sort: Most commented' }))
  await view.unmount()
})

test('runs: workflow and status filters, and no sort', async () => {
  const h = host({ 'workflows.list': { ok: true, workflows: [{ id: 7, name: 'CI' }, { id: 8, name: 'Release' }] } })
  const view = await mount(panel, { host: h, persisted: { plugin: { tab: 'runs' } } })
  assert.equal(view.find({ label: /^Sort/ }), null)
  await view.press({ label: 'Filter' })
  // Picked by name, sent by id: no name lookup on every page.
  await view.select({ label: 'Workflow' }, '8')
  await view.select({ label: 'Status' }, 'failure')
  assert.deepEqual(h.asked.at(-1), { name: 'runs.list', input: { query: '', after: null, filters: { workflow: '8', status: 'failure' } } })
  await view.unmount()
})

test('counts hold their place while loading', async () => {
  // Rendered without setup, so nothing is asked and the Issues list stays loading.
  const view = await mount(() => <KindView kind="issues" />, { host: host() })
  assert.equal(view.findAll({ type: 'Skeleton' }).filter((k) => /count/.test(k.label ?? '')).length, 2)
  await view.unmount()
})

test('big repos read with commas and the search cap', async () => {
  const view = await mount(panel, { host: host({ 'issues.list': () => itemPage(issueRows(30), 1234, 'p2', 56789) }) })
  assert.deepEqual(view.findAll({ type: 'Badge' }).slice(0, 2).map((b) => b.text), ['1,234', '56,789'])
  assert.ok(view.find({ text: 'Page 1 of 34 · 1,234 total · first 1,000 shown' }))
  await view.unmount()
})

test('labels of the old repo that answer after a repo change are dropped', async () => {
  const lib = { ...repoOk, nameWithOwner: 'octo/lib', url: 'https://github.com/octo/lib', path: '/code/lib' }
  const h = host({
    'labels.list': async () => {
      // The focus moves to another repo while the labels are on their way.
      setRepo(lib)
      return { ok: true, names: ['from-octo-app'] }
    }
  })
  const view = await mount(panel, { host: h })
  await view.press({ label: 'Filter' })
  assert.ok(view.find({ text: 'octo/lib' }))
  assert.deepEqual(read(choices).labels, null)
  await view.unmount()
})

test('several workspaces match: pick one, it shows that repo, and Change workspace forgets it', async () => {
  const ambiguous = {
    ok: false as const,
    error: {
      code: 'ambiguous_workspace' as const,
      message: '2 workspaces are on main and named main.',
      candidates: [
        { id: 'w-app', name: 'main', path: '/code/app' },
        { id: 'w-lib', name: 'main', path: '/code/lib' }
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
  await view.press({ type: 'ListItem', text: /^app/ })
  assert.deepEqual(picks, ['/code/app'])
  assert.ok(view.find({ text: 'octo/app' }))
  await view.press({ label: 'Change workspace' })
  assert.ok(view.find({ type: 'ListItem', text: /lib/ }))
  await view.unmount()
})

test('a failed first page shows no count placeholders', async () => {
  const view = await mount(panel, { host: host({ 'issues.list': () => failed('rate_limited', 'API rate limit exceeded.') }) })
  assert.equal(view.findAll({ type: 'Skeleton' }).length, 0)
  await view.unmount()
})
