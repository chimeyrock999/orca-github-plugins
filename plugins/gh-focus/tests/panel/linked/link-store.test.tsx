// Ask agent, once the prompt is typed: when the asked agent stops, the tab asks Orca again what it
// links to the workspace and opens what the agent linked, with no Refresh; over a mock host whose
// `requests` stand in for src/worker.ts.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from '../../../src/panel'
import { issueDetail, links, linkedRows, pullDetail, repoOk } from '../../fixtures/fixtures'
import type { LinkedRef } from '../../../src/shared/protocol'

type Links = ReturnType<typeof links>

/** A host whose `repo.links` answers `linked()` at each call, so a test links an item midway. */
function host(linked: () => Links) {
  const asked: { name: string; input: unknown }[] = []
  const requests: Record<string, (input: never) => unknown> = {
    'repo.get': () => repoOk,
    'repo.links': () => linked(),
    'items.get': ({ items }: { items: LinkedRef[] }) => linkedRows(items),
    'agent.find': () => ({ ok: true, agent: { name: 'Claude Code', terminalId: 't1' }, busy: null }),
    'agent.ask': () => ({ ok: true, agent: 'Claude Code' }),
    'issue.get': () => ({ ok: true, issue: issueDetail() }),
    'pull.get': ({ number }: { number: number }) => ({ ok: true, pull: { ...pullDetail(), number } })
  }
  const logged = Object.fromEntries(
    Object.entries(requests).map(([name, answer]) => [name, (input: never) => (asked.push({ name, input }), answer(input))])
  )
  return Object.assign(mockHost({ requests: logged }), {
    count: (name: string) => asked.filter((a) => a.name === name).length,
    last: (name: string) => asked.filter((a) => a.name === name).at(-1)?.input
  })
}

const stopped = { workspaceId: null, paneKey: 'p1', terminalId: 't1', state: 'done' as const, receivedAt: 1 }
const says = (view: Awaited<ReturnType<typeof mount>>, text: RegExp) => view.summary().some((l) => text.test(l))

/** The panel on `tab` with nothing linked, the agent asked to link one. */
async function asked(tab: 'issues' | 'pulls', h: ReturnType<typeof host>) {
  const view = await mount(panel, { host: h, persisted: { plugin: { tab } } })
  await view.press({ type: 'Button', text: 'Ask Claude Code to link' })
  assert.ok(says(view, /Typed into Claude Code/))
  return view
}

test('the asked agent stops after linking a pull request: it opens, with no Refresh', async () => {
  let now = links()
  const h = host(() => now)
  const view = await asked('pulls', h)
  assert.equal(h.count('pull.get'), 0)
  now = links([], [124])
  await view.emit('agent.status.changed', stopped)
  assert.deepEqual(h.last('pull.get'), { number: 124 })
  assert.equal(says(view, /Typed into Claude Code/), false)
  // It stops again later, with the pull request linked: nothing is asked again.
  const before = h.count('repo.links')
  await view.emit('agent.status.changed', stopped)
  assert.equal(h.count('repo.links'), before)
  await view.unmount()
})

test('the asked agent links two issues and waits: the list shows, nothing opens by itself', async () => {
  let now = links()
  const h = host(() => now)
  const view = await asked('issues', h)
  now = links([120, 119])
  await view.emit('agent.status.changed', { ...stopped, state: 'waiting' })
  assert.equal(h.count('issue.get'), 0)
  assert.equal(h.count('items.get'), 1)
  assert.equal(says(view, /Typed into Claude Code/), false)
  await view.unmount()
})

test('the asked agent stops without linking: the callout stays', async () => {
  const h = host(() => links())
  const view = await asked('issues', h)
  const before = h.count('repo.links')
  await view.emit('agent.status.changed', stopped)
  assert.equal(h.count('repo.links'), before + 1)
  assert.ok(says(view, /Typed into Claude Code/))
  await view.unmount()
})

test('another terminal stopping, or the asked agent working or blocked, asks Orca nothing', async () => {
  const h = host(() => links())
  const view = await asked('pulls', h)
  const before = h.count('repo.links')
  await view.emit('agent.status.changed', { ...stopped, terminalId: 't2' })
  await view.emit('agent.status.changed', { ...stopped, terminalId: undefined })
  await view.emit('agent.status.changed', { ...stopped, state: 'working' })
  await view.emit('agent.status.changed', { ...stopped, state: 'blocked' })
  assert.equal(h.count('repo.links'), before)
  assert.ok(says(view, /Typed into Claude Code/))
  await view.unmount()
})

test('the callout says the item opens by itself once linked', async () => {
  const view = await asked('issues', host(() => links()))
  assert.ok(view.find({ type: 'Text', text: /Once the issue is linked, it opens here\. Refresh if it does not\./ }))
  await view.unmount()
})
