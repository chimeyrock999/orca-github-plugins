// What the panel asks the worker for to spend less of the GitHub budget: Refresh drops what the
// worker keeps, a workspace shown before comes back at once, and a low budget is said and heeded.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from '../../src/panel'
import { failed, issueDetail, links, linkedRows, repoOk } from '../fixtures/fixtures'
import type { GitHubBudget, LinkedRef } from '../../src/shared/protocol'

const low: GitHubBudget = { limit: 5_000, remaining: 312, resetAt: Date.UTC(2026, 10, 13, 14, 5) }

function host(overrides: Record<string, unknown> = {}) {
  const asked: { name: string; input: unknown }[] = []
  const requests: Record<string, unknown> = {
    'repo.get': () => repoOk,
    'repo.links': () => links([120, 119]),
    'items.get': ({ items }: { items: LinkedRef[] }) => linkedRows(items),
    'issue.get': () => ({ ok: true, issue: issueDetail() }),
    'agent.find': { ok: true, agent: null, busy: null },
    'cache.drop': { ok: true },
    'budget.get': { ok: true, budget: null },
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
  return Object.assign(mockHost({ requests: logged }), { asked, count: (name: string) => asked.filter((a) => a.name === name).length })
}

test('Refresh asks the worker to drop what it keeps before it asks again', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  await view.press({ label: 'Refresh' })
  const names = h.asked.map((a) => a.name)
  assert.ok(names.indexOf('cache.drop') >= 0 && names.indexOf('cache.drop') < names.lastIndexOf('repo.get'))
  await view.unmount()
})

test('a low budget shows a warning callout, and it goes once the worker says it is no longer low', async () => {
  const h = host({ 'budget.get': { ok: true, budget: low } })
  const view = await mount(panel, { host: h })
  assert.ok(view.find({ type: 'Callout', text: /GitHub budget low/ }))
  assert.ok(view.find({ text: /^312 of 5,000 requests left until .+, shared with Orca\. The panel asks GitHub less often until then; Refresh still asks now\.$/ }))
  await view.post('budget.changed', { budget: null })
  assert.equal(view.find({ type: 'Callout', text: /GitHub budget low/ }), null)
  await view.post('budget.changed', { budget: { ...low, remaining: 40 } })
  assert.ok(view.find({ text: /^40 of 5,000/ }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a workspace shown before comes back with its list at once, then asks again with the list kept on screen', async () => {
  let rows: number[] = [120, 119]
  const h = host({ 'items.get': ({ items }: { items: LinkedRef[] }) => linkedRows(items.filter((i) => rows.includes(i.number))) })
  const view = await mount(panel, { host: h })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 2)
  await view.post('repo.changed', { ...repoOk, path: '/code/app-other' })
  rows = [120]
  await view.post('repo.changed', { ...repoOk })
  // Asked again (Orca's links and GitHub's rows), and what came back is on screen.
  assert.equal(h.count('items.get'), 3)
  assert.equal(view.findAll({ type: 'ListItem' }).length, 1)
  await view.unmount()
})

test('links changed in Orca while away show on return: a list where one item was', async () => {
  let linkedNow: number[] = [120]
  const h = host({ 'repo.links': () => links(linkedNow) })
  const view = await mount(panel, { host: h })
  assert.ok(view.find({ type: 'Text', text: 'Export CSV drops rows past 10k' }))
  await view.post('repo.changed', { ...repoOk, path: '/code/app-other' })
  linkedNow = [120, 119]
  await view.post('repo.changed', { ...repoOk })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 2)
  await view.unmount()
})

test('a workspace shown before with its only issue opens it at once', async () => {
  const h = host({ 'repo.links': () => links([120]) })
  const view = await mount(panel, { host: h })
  await view.post('repo.changed', { ...repoOk, path: '/code/app-other' })
  await view.post('repo.changed', { ...repoOk })
  assert.ok(view.find({ type: 'Text', text: 'Export CSV drops rows past 10k' }))
  assert.equal(view.find({ text: /← Back to linked/ }), null)
  await view.unmount()
})

test('an answer that fails leaves the list it found, as before', async () => {
  const h = host({ 'items.get': failed('gh_failed', 'no') })
  const view = await mount(panel, { host: h })
  assert.ok(view.find({ text: 'Retry' }))
  await view.unmount()
})
