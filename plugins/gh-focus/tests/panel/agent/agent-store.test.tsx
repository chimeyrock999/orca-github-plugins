// The workspace's agent, shared by the offers that ask it: Link one on the Issues and Pull requests
// tabs, and Ask to fix on a failed run. Each offer keeps its own callout and error, and a view that
// shows again looks the agent up, since it may have started work while another view showed.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from '../../../src/panel'
import { failed, failedLogs, links, linkedRows, pullDetail, repoOk, runDetail, runPage, runRows } from '../../fixtures/fixtures'
import type { LinkedRef } from '../../../src/shared/protocol'

const free = { ok: true, agent: { name: 'Claude Code', terminalId: 't1' }, busy: null }
const blocked = { ok: true, agent: null, busy: { name: 'Claude Code', state: 'blocked' } }

/** Nothing linked, a failed run on the Actions tab, and the agent as `agent()` answers. */
function host(agent: () => unknown, overrides: Record<string, unknown> = {}) {
  const asked: { name: string; input: unknown }[] = []
  const requests: Record<string, unknown> = {
    'repo.get': () => repoOk,
    'repo.links': () => links(),
    'runs.list': () => runPage(runRows, 3),
    'run.get': () => ({ ok: true, run: runDetail() }),
    'run.logs': () => ({ ok: true, logs: failedLogs() }),
    'run.watch': () => ({ ok: true, done: true }),
    'agent.find': agent,
    'agent.ask': () => ({ ok: true, agent: 'Claude Code' }),
    ...overrides
  }
  const logged = Object.fromEntries(
    Object.entries(requests).map(([name, answer]) => [name, (input: unknown) => (asked.push({ name, input }), typeof answer === 'function' ? (answer as (i: unknown) => unknown)(input) : answer)])
  )
  return Object.assign(mockHost({ requests: logged }), {
    count: (name: string) => asked.filter((a) => a.name === name).length,
    last: (name: string) => asked.filter((a) => a.name === name).at(-1)?.input
  })
}

const says = (view: Awaited<ReturnType<typeof mount>>, text: RegExp) => view.summary().some((l) => text.test(l))

async function onFailedRun(h: ReturnType<typeof host>) {
  const view = await mount(panel, { host: h, persisted: { plugin: { tab: 'runs' } } })
  await view.press({ type: 'ListItem', text: /Fix token refresh loop/ })
  return view
}

test('asked to fix a run, the agent then waits on a question: Link one looks it up again and waits for it', async () => {
  let agent: unknown = free
  const h = host(() => agent)
  const view = await onFailedRun(h)
  await view.press({ type: 'Button', text: 'Ask Claude Code to fix' })
  assert.ok(says(view, /Typed into Claude Code/))
  agent = blocked
  await view.select({ type: 'Tabs' }, 'issues')
  assert.equal(view.find({ type: 'Button', text: 'Ask Claude Code to link' })?.props.disabled, true)
  assert.ok(view.find({ text: /Claude Code is waiting on a question/ }))
  await view.unmount()
})

test('back on a failed run from another tab, the agent is looked up again', async () => {
  let agent: unknown = free
  const h = host(() => agent)
  const view = await onFailedRun(h)
  assert.equal(view.find({ type: 'Button', text: 'Ask Claude Code to fix' })?.props.disabled, false)
  await view.select({ type: 'Tabs' }, 'pulls')
  agent = blocked
  const before = h.count('agent.find')
  await view.select({ type: 'Tabs' }, 'runs')
  assert.ok(h.count('agent.find') > before)
  assert.equal(view.find({ type: 'Button', text: 'Ask Claude Code to fix' })?.props.disabled, true)
  await view.unmount()
})

test('a failed run whose first read failed offers the agent once Retry reads it', async () => {
  let read = 0
  const h = host(() => free, { 'run.get': () => (++read === 1 ? failed('timeout', 'gh did not answer') : { ok: true, run: runDetail() }) })
  const view = await onFailedRun(h)
  assert.equal(view.find({ type: 'Button', text: /^Ask / }), null)
  await view.press({ type: 'Button', text: 'Retry' })
  assert.ok(view.find({ type: 'Button', text: 'Ask Claude Code to fix' }))
  await view.unmount()
})

test('a link ask that failed shows on Link one only, not under a failed run', async () => {
  const h = host(() => free, { 'agent.ask': () => failed('host_failed', 'Orca could not type') })
  const view = await mount(panel, { host: h })
  await view.press({ type: 'Button', text: 'Ask Claude Code to link' })
  assert.ok(says(view, /Orca did not answer/))
  await view.select({ type: 'Tabs' }, 'runs')
  await view.press({ type: 'ListItem', text: /Fix token refresh loop/ })
  assert.ok(view.find({ type: 'Button', text: 'Ask Claude Code to fix' }))
  assert.ok(!says(view, /Orca did not answer/))
  await view.unmount()
})

test('a failed run looked at while the agent links a pull request: once it stops, the pull request opens', async () => {
  let now = links()
  const h = host(() => free, {
    'repo.links': () => now,
    'items.get': ({ items }: { items: LinkedRef[] }) => linkedRows(items),
    'pull.get': ({ number }: { number: number }) => ({ ok: true, pull: { ...pullDetail(), number } })
  })
  const view = await mount(panel, { host: h, persisted: { plugin: { tab: 'pulls' } } })
  await view.press({ type: 'Button', text: 'Ask Claude Code to link' })
  await view.select({ type: 'Tabs' }, 'runs')
  await view.press({ type: 'ListItem', text: /Fix token refresh loop/ })
  assert.ok(view.find({ type: 'Button', text: 'Ask Claude Code to fix' }))
  // The agent works on it, links 124 and stops, while the run shows.
  const status = { workspaceId: 'raw-app', workspaceListId: repoOk.workspaceId, paneKey: 'p1', terminalId: 't1', receivedAt: 1 }
  await view.emit('agent.status.changed', { ...status, state: 'working' })
  now = links([], [124])
  await view.emit('agent.status.changed', { ...status, state: 'done' })
  // The Pull requests tab asks Orca again once it shows, and opens what the agent linked.
  await view.select({ type: 'Tabs' }, 'pulls')
  assert.deepEqual(h.last('pull.get'), { number: 124 })
  assert.ok(!says(view, /No pull request for this workspace/))
  await view.unmount()
})

test('asked about a run, looking up the agent elsewhere keeps the run\'s callout', async () => {
  const h = host(() => free)
  const view = await onFailedRun(h)
  await view.press({ type: 'Button', text: 'Ask Claude Code to fix' })
  await view.select({ type: 'Tabs' }, 'issues')
  await view.select({ type: 'Tabs' }, 'runs')
  assert.ok(says(view, /Typed into Claude Code/))
  await view.unmount()
})
