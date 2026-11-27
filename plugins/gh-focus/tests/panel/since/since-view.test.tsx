// The "Since you were here" block: shown above the tabs after an absence, only for the workspace it
// was asked in, each line opening what it names, Dismiss for good, and nothing when nothing changed.
import { assert, mockHost, mount, test } from 'orca/testing'
import { read } from 'orca'
import * as panel from '../../../src/panel'
import { lists, tab } from '../../../src/panel/store'
import { before, failed, issueDetail, links, linkedRows, pullDetail, repoOk, runDetail, runPage, runRows, sinceAnswer, sinceItem } from '../../fixtures/fixtures'
import type { LinkedRef } from '../../../src/shared/protocol'

function host(overrides: Record<string, unknown> = {}) {
  const asked: { name: string; input: unknown }[] = []
  const requests: Record<string, unknown> = {
    'repo.get': () => repoOk,
    'repo.links': () => links([120, 98], [131]),
    'items.get': ({ items }: { items: LinkedRef[] }) => linkedRows(items),
    'issue.get': () => ({ ok: true, issue: issueDetail() }),
    'pull.get': () => ({ ok: true, pull: pullDetail() }),
    'run.get': () => ({ ok: true, run: runDetail() }),
    'runs.list': () => runPage(runRows),
    'agent.find': { ok: true, agent: null, busy: null },
    'budget.get': { ok: true, budget: null },
    'since.get': () => sinceAnswer(),
    'since.dismiss': { ok: true },
    ...overrides
  }
  const logged = Object.fromEntries(
    Object.entries(requests).map(([name, answer]) => [
      name,
      (input: unknown) => {
        asked.push({ name, input })
        return typeof answer === 'function' ? (answer as (i: unknown) => unknown)(input) : answer
      }
    ])
  )
  return Object.assign(mockHost({ requests: logged }), {
    asked,
    count: (name: string) => asked.filter((a) => a.name === name).length
  })
}

const block = (view: Awaited<ReturnType<typeof mount>>) => view.find({ type: 'List', label: 'Since you were here' })

test('after an absence the block shows above the tabs: the changed items, then the finished runs', async () => {
  const view = await mount(panel, { host: host() })
  assert.ok(view.find({ text: 'Since you were here' }))
  const list = block(view)
  assert.ok(list)
  const lines = view.findAll({ type: 'ListItem' }).filter((l) => l.path.startsWith(list!.path))
  assert.equal(lines.length, 3)
  assert.ok(view.find({ text: '#131 Fix token refresh loop' }))
  assert.ok(view.find({ text: 'approved by kenji · merged' }))
  assert.ok(view.find({ text: '2 comments (olu, you)' }))
  assert.ok(view.find({ text: 'CI #297' }))
  assert.ok(view.find({ text: 'failed on' }))
  assert.ok(before(list!.path, view.find({ type: 'Tabs' })!.path))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('nothing changed, not away, or a failure: no block', async () => {
  for (const answer of [sinceAnswer({ items: [], runs: [] }), sinceAnswer({ since: null, items: [], runs: [] }), failed('gh_failed', 'no')]) {
    const view = await mount(panel, { host: host({ 'since.get': answer }) })
    assert.equal(view.find({ text: 'Since you were here' }), null)
    assert.deepEqual(view.errors, [])
    await view.unmount()
  }
})

test('a line opens what it names: an item in its tab with the linked list behind it, a run on Actions', async () => {
  const view = await mount(panel, { host: host() })
  await view.press({ type: 'ListItem', text: /#131 Fix token refresh loop/ })
  assert.equal(read(tab), 'pulls')
  assert.equal(read(lists.pulls).open, '131')
  // Pressing a line keeps the block.
  assert.ok(view.find({ text: 'Since you were here' }))
  await view.press({ type: 'ListItem', text: /CI #297/ })
  assert.equal(read(tab), 'runs')
  assert.equal(read(lists.runs).open, '9002')
  await view.press({ type: 'ListItem', text: /#120 Export CSV/ })
  assert.equal(read(tab), 'issues')
  assert.equal(read(lists.issues).open, '120')
  assert.ok(view.find({ text: '← Back to linked issues' }))
  await view.unmount()
})

test('Dismiss hides the block and tells the worker; a workspace change asks again', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  await view.press({ type: 'Button', text: 'Dismiss' })
  assert.equal(view.find({ text: 'Since you were here' }), null)
  assert.equal(h.count('since.dismiss'), 1)
  // For the workspace the block was asked in, whatever the worker's focus is by then.
  assert.deepEqual(h.asked.filter((a) => a.name.startsWith('since.')).map((a) => [a.name, a.input]), [
    ['since.get', { workspaceId: 'w-app' }],
    ['since.dismiss', { workspaceId: 'w-app' }]
  ])
  await view.post('repo.changed', { ...repoOk, path: '/code/app-other', workspaceId: 'w-other' })
  assert.equal(h.count('since.get'), 2)
  assert.ok(view.find({ text: 'Since you were here' }))
  await view.unmount()
})

test('more than five lines: the rest behind "and N more"; a low budget says what was skipped', async () => {
  const items = Array.from({ length: 6 }, (_, i) => sinceItem({ number: 200 + i, title: `Item ${i}` }))
  const view = await mount(panel, { host: host({ 'since.get': sinceAnswer({ items, skipped: true }) }) })
  const lines = () => view.findAll({ type: 'ListItem' }).filter((l) => l.path.startsWith(block(view)!.path)).length
  assert.equal(lines(), 5)
  assert.ok(view.find({ text: 'Comments and reviews skipped while the GitHub budget is low.' }))
  await view.press({ type: 'Button', text: 'and 2 more' })
  assert.equal(lines(), 7)
  await view.unmount()
})

test('with the budget low and no run finished, the block still says comments and reviews were skipped', async () => {
  const view = await mount(panel, { host: host({ 'since.get': sinceAnswer({ items: [], runs: [], skipped: true }) }) })
  assert.ok(view.find({ text: 'Since you were here' }))
  assert.ok(view.find({ text: 'Comments and reviews skipped while the GitHub budget is low.' }))
  await view.unmount()
})

test('another workspace drops the block at once; it shows only what that workspace answers', async () => {
  let answer = sinceAnswer()
  const view = await mount(panel, { host: host({ 'since.get': () => answer }) })
  assert.ok(view.find({ text: 'Since you were here' }))
  answer = sinceAnswer({ since: null, items: [], runs: [] })
  await view.post('repo.changed', { ...repoOk, path: '/code/app-other', workspaceId: 'w-other' })
  assert.equal(view.find({ text: 'Since you were here' }), null)
  await view.unmount()
})
