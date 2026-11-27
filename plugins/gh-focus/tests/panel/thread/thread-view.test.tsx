// The agent button on an open issue's body and comments (`AskButton`, `AskProblem`): offered only
// while the workspace's agent takes a prompt, typed without Enter, and refused when it no longer can.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from '../../../src/panel'
import { failed, issueDetail, links, pullDetail, repoOk } from '../../fixtures/fixtures'
import { agentNow, askAgent } from '../../../src/panel/agent/agent-store'
import type { IssueDetail } from '../../../src/shared/protocol'

const free = { ok: true, agent: { name: 'Claude Code', terminalId: 't1' }, busy: null }
const blocked = { ok: true, agent: null, busy: { name: 'Claude Code', state: 'blocked' } }

function host(overrides: Record<string, unknown> = {}, detail: () => IssueDetail = () => issueDetail()) {
  const asked: { name: string; input: unknown }[] = []
  const requests: Record<string, unknown> = {
    'repo.get': repoOk,
    // Only issue 120 is linked, so it opens by itself.
    'repo.links': links([120]),
    'agent.find': free,
    'agent.ask': { ok: true, agent: 'Claude Code', working: false },
    'issue.get': () => ({ ok: true, issue: detail() }),
    'pull.get': () => ({ ok: true, pull: pullDetail() }),
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
    last: (name: string) => asked.filter((a) => a.name === name).at(-1)?.input,
    count: (name: string) => asked.filter((a) => a.name === name).length
  })
}

type View = Awaited<ReturnType<typeof mount>>
const asks = (view: View, what: 'comment' | 'issue') => view.findAll({ type: 'IconButton', label: `Ask Claude Code about this ${what}` })
const says = (view: View, text: RegExp) => view.summary().some((l) => text.test(l))

/** Waits (up to a second) for `done`, so a step the panel draws later is not raced. */
async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; !done() && waited < 1000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10))
}

/** What Orca sends a panel when an agent of the panel's workspace starts or stops. */
const agentStatus = { workspaceId: 'raw-app', workspaceListId: repoOk.workspaceId, paneKey: 'p1', terminalId: 't1', state: 'done' as const, receivedAt: 1 }

test('an open issue offers its body and every comment to the agent; a press types the prompt and shows nothing more', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  assert.deepEqual(h.last('issue.get'), { number: 120 })
  assert.equal(h.count('agent.find'), 1)
  // Each comment, including ones this login cannot edit, and the body.
  assert.equal(asks(view, 'comment').length, 2)
  assert.equal(asks(view, 'issue').length, 1)
  await view.press(asks(view, 'comment')[0])
  assert.deepEqual(h.last('agent.ask'), { about: { issue: 120, repo: null, comment: 1001 }, terminalId: 't1' })
  await view.press(asks(view, 'issue')[0])
  assert.deepEqual(h.last('agent.ask'), { about: { issue: 120, repo: null, comment: null }, terminalId: 't1' })
  // The prompt waits in the agent's terminal: the panel says nothing more, and offers it again.
  assert.equal(view.find({ type: 'Callout' }), null)
  assert.equal(asks(view, 'comment')[0].props.disabled, false)
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test("another repo's issue names its repo", async () => {
  const h = host({ 'repo.links': links(['octo/sdk#45']) }, () => issueDetail({ number: 45, url: 'https://github.com/octo/sdk/issues/45' }))
  const view = await mount(panel, { host: h })
  await view.press(asks(view, 'comment')[1])
  assert.deepEqual(h.last('agent.ask'), { about: { issue: 45, repo: 'octo/sdk', comment: 1002 }, terminalId: 't1' })
  await view.unmount()
})

test('no button while no agent can take a prompt; one comes once an agent of the workspace can', async () => {
  let found: unknown = blocked
  const h = host({ 'agent.find': () => found })
  const view = await mount(panel, { host: h })
  assert.equal(view.find({ type: 'IconButton', label: /^Ask / }), null)
  // A comment this login cannot edit or delete has no tools at all.
  assert.equal(view.findAll({ type: 'Toolbar', label: 'Comment actions' }).length, 1)
  found = free
  await view.emit('agent.status.changed', agentStatus)
  assert.equal(h.count('agent.find'), 2)
  assert.equal(asks(view, 'comment').length, 2)
  await view.unmount()
})

test('while a prompt is on the way, another ask sends nothing', async () => {
  let answer: (a: unknown) => void = () => undefined
  const h = host({ 'agent.ask': () => new Promise((resolve) => (answer = resolve)) })
  const view = await mount(panel, { host: h })
  const first = askAgent({ issue: 120, repo: null, comment: 1001 })
  await until(() => h.count('agent.ask') === 1)
  await askAgent({ issue: 120, repo: null, comment: 1002 })
  assert.equal(h.count('agent.ask'), 1)
  assert.equal(agentNow()?.asking, true)
  answer({ ok: true, agent: 'Claude Code', working: false })
  await first
  assert.equal(agentNow()?.asking, false)
  await view.unmount()
})

test('an agent that waits on a question by the press: nothing typed, the post says why, and the agent is looked for again', async () => {
  let found: unknown = free
  const h = host({
    'agent.find': () => found,
    'agent.ask': () => {
      found = blocked
      return failed('no_agent', 'That agent waits on a question now, is gone, or is not in this workspace.')
    }
  })
  const view = await mount(panel, { host: h })
  await view.press(asks(view, 'comment')[1])
  assert.equal(h.count('agent.find'), 2)
  assert.ok(says(view, /No agent free/))
  assert.equal(view.find({ type: 'IconButton', label: /^Ask / }), null)
  // Another agent of the workspace changing state keeps the reason on screen.
  await view.emit('agent.status.changed', agentStatus)
  assert.equal(h.count('agent.find'), 3)
  assert.ok(says(view, /No agent free/))
  await view.press({ type: 'Button', text: 'Dismiss' })
  assert.equal(says(view, /No agent free/), false)
  await view.unmount()
})

test('an issue opened after the agent was asked to link one still follows the agent', async () => {
  let linked: number[] = []
  let found: unknown = free
  const h = host({ 'repo.links': () => links(linked), 'agent.find': () => found })
  const view = await mount(panel, { host: h })
  await view.press({ type: 'Button', text: 'Ask Claude Code to link' })
  // The agent links issue 120; Refresh opens it.
  linked = [120]
  await view.press({ label: 'Refresh' })
  assert.deepEqual(h.last('issue.get'), { number: 120 })
  assert.equal(asks(view, 'comment').length, 2)
  // The agent then waits on a question: its buttons go, without Refresh.
  found = blocked
  await view.emit('agent.status.changed', agentStatus)
  assert.equal(view.find({ type: 'IconButton', label: /^Ask / }), null)
  await view.unmount()
})

test('a pull request offers nothing to the agent', async () => {
  const h = host({ 'repo.links': links([], [131]) })
  const view = await mount(panel, { host: h, persisted: { plugin: { tab: 'pulls' } } })
  assert.deepEqual(h.last('pull.get'), { number: 131 })
  assert.equal(view.find({ type: 'IconButton', label: /^Ask / }), null)
  assert.equal(h.count('agent.find'), 0)
  await view.unmount()
})
