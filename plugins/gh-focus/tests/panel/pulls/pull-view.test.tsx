// The Pull requests tab: the focused workspace's pull request (linked by Orca, or its branch's), its
// checks and timeline, every write (comment, review), and the hand-offs to Orca's Tasks page and
// Checks tab, over a mock host whose `requests` stand in for src/worker.ts.
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from '../../../src/panel'
import { before, failed, links, linkedRows, pullDetail, ref, repoOk, rowOf } from '../../fixtures/fixtures'
import { canReview, timing } from '../../../src/panel/pulls/pull-store'
import type { PullDetail, TimelineItem } from '../../../src/shared/protocol'

const ok = { ok: true } as const

function host(overrides: Record<string, unknown> = {}, detail: (number: number) => PullDetail = () => pullDetail()) {
  const asked: { name: string; input: unknown }[] = []
  const log = <I, O>(name: string, answer: (input: I) => O) => (input: I): O => {
    asked.push({ name, input })
    return answer(input)
  }
  const requests: Record<string, unknown> = {
    'repo.get': () => repoOk,
    // The workspace's branch has pull request 124.
    'repo.links': links([], [124]),
    'items.get': ({ items }: { items: Parameters<typeof linkedRows>[0] }) => linkedRows(items, 'pulls'),
    'agent.find': { ok: true, agent: { name: 'Claude Code', terminalId: 't1' } },
    'agent.ask': { ok: true, agent: 'Claude Code' },
    // The pull request asked for, so each number opens its own.
    'pull.get': ({ number }: { number: number }) => ({ ok: true, pull: { ...detail(number), number, url: `https://github.com/octo/app/pull/${number}` } }),
    'pull.comment': () => ok,
    'pull.review': () => ok,
    'pull.ready': () => ok,
    'pull.edit': () => ok,
    'orca.show': () => ok,
    'comment.edit': () => ok,
    'comment.delete': () => ok,
    'reaction.set': () => ok,
    'labels.list': { ok: true, names: ['bug', 'export'] },
    ...overrides
  }
  const logged = Object.fromEntries(Object.entries(requests).map(([name, answer]) => [name, log(name, typeof answer === 'function' ? (answer as (i: unknown) => unknown) : () => answer)]))
  return Object.assign(mockHost({ requests: logged }), {
    asked,
    last: (name: string) => asked.filter((a) => a.name === name).at(-1)?.input,
    count: (name: string) => asked.filter((a) => a.name === name).length
  })
}

const onPulls = { persisted: { plugin: { tab: 'pulls' } } }

/** The panel on the Pull requests tab, which opens the workspace's pull request. */
function openPull(h = host()) {
  return mount(panel, { host: h, ...onPulls })
}

/** Waits (up to a second) for `done`, so a timer-driven step is not raced on a slow machine. */
async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; !done() && waited < 1000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10))
}

const draftBox = (view: Awaited<ReturnType<typeof mount>>) => view.findAll({ type: 'Callout' }).find((c) => c.props.title === 'Convert #124 to draft?') ?? null
const says = (view: Awaited<ReturnType<typeof mount>>, text: RegExp) => view.summary().some((l) => text.test(l))
const mentionOf = (number: number): TimelineItem => ({
  kind: 'mention',
  id: `CRE_${number}`,
  actor: 'ana',
  createdAt: Date.UTC(2026, 10, 12),
  source: { type: 'pull', number, title: 'refactor: CSV writer', url: `https://github.com/octo/app/pull/${number}`, state: 'open', repo: 'octo/app' }
})

test('the tab opens the workspace pull request: refs, review, merge, reviewers, checks, body and timeline', async () => {
  const h = host()
  const view = await openPull(h)
  assert.deepEqual(h.last('pull.get'), { number: 124 })
  // The Pull requests tab asks for the branch's pull request when Orca links none.
  assert.deepEqual(h.last('repo.links'), { branch: true })
  assert.equal(h.count('items.get'), 0)
  assert.ok(view.find({ type: 'Text', text: 'fix: stream CSV export past 10k rows' }))
  // Its own pull request: no Back, and Tasks for the rest of the repo's.
  assert.equal(view.find({ type: 'Button', text: /^← Back(?! to Orca Tasks)/ }), null)
  assert.ok(view.find({ type: 'Button', text: '← Back to Orca Tasks' }))
  assert.deepEqual(view.findAll({ type: 'Code' }).map((c) => c.text), ['dev', 'kenji:stream-export'])
  assert.ok(view.find({ text: 'Changes requested' }))
  // Mergeable, but a check fails: Orca's words.
  assert.ok(view.find({ text: 'Checks failed' }))
  assert.ok(view.find({ text: 'ana' }))
  // One line for the checks, no list: Orca's Checks tab has them, with logs and reruns.
  assert.equal(view.find({ type: 'Collapsible' }), null)
  // The glyph stays beside the line when it wraps in a narrow sidebar.
  const line = view.find({ type: 'Link', text: '1 failing · 1 pending · 4 passed' })
  const holder = view.findAll({ type: 'Row' }).find((r) => r.path === rowOf(line!.path))
  assert.ok(holder && holder.props.wrap !== true)
  assert.equal(view.findAll({ type: 'Text', text: '✕' }).filter((t) => t.path.startsWith(`${holder.path}/`)).length, 1)
  await view.press({ type: 'Link', text: '1 failing · 1 pending · 4 passed' })
  assert.deepEqual(h.last('orca.show'), { view: 'checks' })
  // Reviews: a box when they say something, one line when not.
  assert.ok(view.find({ text: /^\s*reviewed\b/ }))
  assert.ok(view.find({ text: /2 comments on the diff/ }))
  assert.ok(view.find({ text: /requested changes/ }))
  assert.ok(view.find({ text: /approved these changes/ }))
  assert.ok(view.findAll({ type: 'Markdown' }).some((m) => /\[#120\]\(https:\/\/github\.com\/octo\/app\/issues\/120\)/.test(String(m.props.content))))
  // No close or reopen: Orca's own pull request views do that.
  assert.equal(view.find({ type: 'Button', text: /^Close/ }), null)
  await view.press({ label: 'Open on GitHub', type: 'IconButton' })
  assert.deepEqual(h.callsOf('shell.openExternal').at(-1), { url: 'https://github.com/octo/app/pull/124' })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('Tasks hands off to the Orca Tasks page; when Orca will not, it says why', async () => {
  const h = host()
  const view = await openPull(h)
  await view.press({ type: 'Button', text: '← Back to Orca Tasks' })
  assert.deepEqual(h.last('orca.show'), { view: 'tasks' })
  assert.ok(!says(view, /Orca did not answer/))
  await view.unmount()

  // The worker answers a refused commands.run with Orca's code.
  const refused = await openPull(host({ 'orca.show': () => failed('unavailable', 'Not the desktop app') }))
  await refused.press({ type: 'Button', text: '← Back to Orca Tasks' })
  assert.ok(says(refused, /Not available in Orca/))
  assert.ok(!says(refused, /Orca did not answer/))
  await refused.press({ type: 'Button', text: 'Dismiss' })
  assert.ok(!says(refused, /Not available in Orca/))
  await refused.unmount()
})

test('the review threads of the workspace pull request open in the Orca Checks tab', async () => {
  const h = host()
  const view = await openPull(h)
  assert.equal(view.findAll({ type: 'Button', text: 'Open in Checks' }).length, 2)
  await view.press(view.findAll({ type: 'Button', text: 'Open in Checks' })[0])
  assert.deepEqual(h.last('orca.show'), { view: 'checks' })
  await view.unmount()
})

test('a branch with no pull request says so, with how to link one, Tasks and the repo pull requests on GitHub', async () => {
  const h = host({ 'repo.links': links() })
  const view = await openPull(h)
  assert.equal(h.count('pull.get'), 0)
  assert.ok(says(view, /No pull request for this workspace/))
  assert.ok(view.find({ type: 'Code', text: 'orca reference add https://github.com/octo/app/pull/<number> --worktree current' }))
  await view.press({ type: 'Button', text: 'Open on GitHub' })
  assert.deepEqual(h.callsOf('shell.openExternal').at(-1), { url: 'https://github.com/octo/app/pulls' })
  await view.press({ type: 'Button', text: 'Tasks' })
  assert.deepEqual(h.last('orca.show'), { view: 'tasks' })
  await view.unmount()

  // No answer from the worker reads the same as no pull request.
  const silent = await openPull(host({ 'repo.links': failed('host_failed', 'orca CLI missing') }))
  assert.ok(says(silent, /No pull request for this workspace/))
  await silent.unmount()
})

test('Refresh finds a pull request opened for the branch meanwhile, and reloads the one on screen', async () => {
  let pullNumber: number | null = null
  const h = host({ 'repo.links': () => links([], pullNumber ? [pullNumber] : []) })
  const view = await openPull(h)
  assert.ok(says(view, /No pull request for this workspace/))
  pullNumber = 124
  await view.press({ label: 'Refresh' })
  assert.deepEqual(h.last('pull.get'), { number: 124 })
  assert.equal(h.count('pull.get'), 1)
  await view.press({ label: 'Refresh' })
  assert.equal(h.count('pull.get'), 2)
  await view.unmount()
})

test('another pull request opened from a mention leads back to the workspace one', async () => {
  const h = host({}, (number) => pullDetail(number === 124 ? { head: [mentionOf(131)], total: 1 } : {}))
  const view = await openPull(h)
  await view.press({ type: 'ListItem', text: /refactor: CSV writer/ })
  assert.deepEqual(h.last('pull.get'), { number: 131 })
  // Checks is the workspace's pull request; for another one its threads and checks stay on GitHub.
  assert.equal(view.find({ type: 'Button', text: 'Open in Checks' }), null)
  await view.press({ type: 'Link', text: '1 failing · 1 pending · 4 passed' })
  assert.deepEqual(h.callsOf('shell.openExternal').at(-1), { url: 'https://github.com/octo/app/pull/131/checks' })
  // ← Back to Orca Tasks heads it with Edit and Open on GitHub beside it; Back has a row of its own below.
  const tasks = view.find({ type: 'Button', text: '← Back to Orca Tasks' })
  const back = view.find({ type: 'Button', text: '← Back to #124' })
  assert.ok(tasks && back)
  const row = rowOf(tasks.path)
  const inRow = (label: string) => view.findAll({ type: 'IconButton', label }).some((b) => b.path.startsWith(`${row}/`))
  assert.ok(inRow('Open on GitHub'))
  assert.ok(inRow('Edit title and body'))
  // In a narrow sidebar Edit and Open on GitHub keep their row instead of stacking under each other.
  const bar = view.findAll({ type: 'Toolbar' }).find((b) => b.props.label === 'Pull request')
  assert.equal(view.findAll({ type: 'Box' }).find((b) => b.path === rowOf(bar!.path))?.props.shrink, false)
  // Narrower still, they move under Back to Orca Tasks rather than push it past the edge.
  assert.equal(view.findAll({ type: 'Row' }).find((r) => r.path === row)?.props.wrap, true)
  assert.ok(!back.path.startsWith(`${row}/`))
  assert.ok(before(tasks.path, back.path))
  await view.press({ type: 'Button', text: '← Back to #124' })
  assert.deepEqual(h.last('pull.get'), { number: 124 })
  assert.equal(view.find({ type: 'Button', text: /^← Back(?! to Orca Tasks)/ }), null)
  await view.unmount()
})

test('several linked pull requests make a list; Back from one returns to it; Checks is for the first of this repo', async () => {
  const h = host({ 'repo.links': links([], [124, 'octo/sdk#7', 131]) })
  const view = await openPull(h)
  assert.equal(h.count('pull.get'), 0)
  assert.deepEqual(h.last('items.get'), { kind: 'pulls', items: [ref(124), ref('octo/sdk#7'), ref(131)] })
  assert.ok(view.find({ text: '3 linked pull requests' }))
  await view.press({ type: 'ListItem', text: /Export CSV drops rows/ })
  assert.deepEqual(h.last('pull.get'), { number: 131 })
  // Orca's Checks tab shows the workspace's own pull request, not this one.
  await view.press({ type: 'Link', text: '1 failing · 1 pending · 4 passed' })
  assert.deepEqual(h.callsOf('shell.openExternal').at(-1), { url: 'https://github.com/octo/app/pull/131/checks' })
  await view.press({ type: 'Button', text: '← Back to linked pull requests' })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 3)
  await view.press({ type: 'ListItem', text: /Login page loops/ })
  await view.press({ type: 'Link', text: '1 failing · 1 pending · 4 passed' })
  assert.deepEqual(h.last('orca.show'), { view: 'checks' })
  await view.unmount()
})

test('Ask agent types the link prompt into the agent; the person presses Enter there', async () => {
  const h = host({ 'repo.links': links() })
  const view = await openPull(h)
  await view.press({ type: 'Button', text: 'Ask Claude Code to link' })
  assert.deepEqual(h.last('agent.ask'), { kind: 'pulls', terminalId: 't1' })
  assert.ok(says(view, /Typed into Claude Code/))
  await view.press({ type: 'Button', text: 'Show the command again' })
  assert.ok(view.find({ type: 'Button', text: 'Ask Claude Code to link' }))
  await view.unmount()

  // No agent free by the time it is asked: the button goes, the command stays, and it says why.
  const busy = await openPull(host({ 'repo.links': links(), 'agent.ask': failed('no_agent', 'No agent in this workspace is waiting for input.') }))
  await busy.press({ type: 'Button', text: 'Ask Claude Code to link' })
  assert.ok(says(busy, /No agent free/))
  assert.equal(busy.find({ type: 'Button', text: 'Ask Claude Code to link' }), null)
  assert.ok(busy.find({ text: /No agent is free in this workspace to ask/ }))
  await busy.unmount()

  // None free from the start: no button.
  const none = await openPull(host({ 'repo.links': links(), 'agent.find': { ok: true, agent: null } }))
  assert.equal(none.find({ type: 'Button', text: /^Ask / }), null)
  assert.ok(none.find({ text: /No agent is free in this workspace to ask/ }))
  await none.unmount()
})

test('a tab not on screen while the focus went elsewhere and back still shows the workspace pull request', async () => {
  const other = { ...repoOk, path: '/code/app-other' }
  const h = host()
  const view = await openPull(h)
  await view.select({ type: 'Tabs' }, 'issues')
  await view.post('repo.changed', other)
  await view.post('repo.changed', repoOk)
  await view.select({ type: 'Tabs' }, 'pulls')
  assert.ok(view.find({ type: 'Text', text: 'fix: stream CSV export past 10k rows' }))
  assert.deepEqual(h.last('pull.get'), { number: 124 })
  await view.unmount()
})

test('the workspace pull request waits for the tab to show', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  assert.equal(h.count('pull.get'), 0)
  await view.select({ type: 'Tabs' }, 'pulls')
  assert.deepEqual(h.last('pull.get'), { number: 124 })
  await view.select({ type: 'Tabs' }, 'issues')
  await view.select({ type: 'Tabs' }, 'pulls')
  assert.equal(h.count('pull.get'), 1)
  await view.unmount()
})

test('a merge state GitHub has not worked out yet is asked again once, a moment later', async () => {
  // Long enough that opening the pull request (first ask and render) ends before the retry.
  timing.mergeRetryMs = 50
  // The first ask answers unknown, every later one clean, whenever the retry comes.
  let asks = 0
  const h = host({}, () => pullDetail({ merge: ++asks === 1 ? 'unknown' : 'clean' }))
  const view = await openPull(h)
  assert.ok(view.find({ text: 'Checking' }))
  await until(() => h.count('pull.get') >= 2)
  await view.settled()
  assert.equal(h.count('pull.get'), 2)
  assert.ok(view.find({ text: 'Able to merge' }))
  await view.unmount()

  // Still unknown after the second ask: no third, until Refresh.
  const still = host({}, () => pullDetail({ merge: 'unknown' }))
  const again = await openPull(still)
  await until(() => still.count('pull.get') >= 2)
  // Long enough for a third ask, were there one.
  await new Promise((resolve) => setTimeout(resolve, 150))
  await again.settled()
  assert.equal(still.count('pull.get'), 2)
  await again.unmount()
  timing.mergeRetryMs = 4_000
})

test('no checks shows no line, no review decision no Review line; a merged pull request offers only Comment', async () => {
  const ready = pullDetail({ merge: 'clean', checks: { passed: 5, failed: 0, cancelled: 0, needsAction: 0, pending: 0, neutral: 0 } })
  let view = await openPull(host({}, () => ready))
  assert.ok(view.find({ text: 'Able to merge' }))
  assert.ok(view.find({ type: 'Link', text: '5 passed' }))
  await view.unmount()
  view = await openPull(host({}, () => pullDetail({ state: 'draft', merge: 'draft', review: null, checks: null })))
  assert.equal(view.find({ text: 'Checks' }), null)
  assert.equal(view.find({ text: 'Review' }), null)
  assert.ok(view.find({ text: 'Draft' }))
  await view.unmount()
  view = await openPull(host({}, () => pullDetail({ state: 'merged', merge: 'unknown' })))
  assert.equal(view.find({ text: 'Checking' }), null)
  assert.equal(view.find({ text: 'Review…' }), null)
  assert.ok(view.find({ type: 'Button', text: 'Comment' }))
  await view.unmount()
})

test('Comment sends the text through pull.comment and loads the pull request again', async () => {
  const h = host()
  const view = await openPull(h)
  await view.type({ label: 'Comment' }, 'Thanks, testing it now.')
  await view.press({ type: 'Button', text: 'Comment' })
  assert.deepEqual(h.last('pull.comment'), { number: 124, body: 'Thanks, testing it now.' })
  assert.equal(h.count('pull.get'), 2)
  assert.equal(view.valueOf({ label: 'Comment' }), '')
  await view.unmount()
})

test('own comments edit and delete in place, as on an issue', async () => {
  const h = host()
  const view = await openPull(h)
  assert.equal(view.findAll({ label: 'Edit comment' }).length, 1)
  await view.press({ label: 'Delete comment' })
  assert.ok(says(view, /Delete this comment\?/))
  await view.press({ type: 'Button', text: 'Delete' })
  assert.deepEqual(h.last('comment.delete'), { id: 1005 })
  assert.equal(view.find({ text: 'Fixed in the last push.' }), null)
  assert.equal(h.count('pull.get'), 1)
  await view.unmount()
})

test('Review: Comment and Request changes need text, Approve does not; the text is the body', async () => {
  const h = host()
  const view = await openPull(h)
  await view.press({ type: 'Button', text: 'Review…' })
  assert.ok(says(view, /Review #124/))
  const submit = () => view.find({ type: 'Button', text: 'Submit review' })
  assert.equal(submit()?.disabled, true)
  await view.select({ label: 'Review' }, 'request_changes')
  assert.equal(submit()?.disabled, true)
  await view.type({ label: 'Comment' }, 'Close the writer in a finally block.')
  assert.equal(submit()?.disabled, false)
  await view.press({ type: 'Button', text: 'Submit review' })
  assert.deepEqual(h.last('pull.review'), { number: 124, event: 'request_changes', body: 'Close the writer in a finally block.' })
  assert.equal(view.valueOf({ label: 'Comment' }), '')
  assert.equal(view.find({ type: 'Button', text: 'Submit review' }), null)
  assert.equal(h.count('pull.get'), 2)

  await view.press({ type: 'Button', text: 'Review…' })
  await view.select({ label: 'Review' }, 'approve')
  assert.equal(submit()?.disabled, false)
  await view.press({ type: 'Button', text: 'Submit review' })
  assert.deepEqual(h.last('pull.review'), { number: 124, event: 'approve', body: '' })

  await view.press({ type: 'Button', text: 'Review…' })
  await view.type({ label: 'Comment' }, 'Two nits.')
  await view.press({ type: 'Button', text: 'Submit review' })
  assert.deepEqual(h.last('pull.review'), { number: 124, event: 'comment', body: 'Two nits.' })
  await view.unmount()
})

test('while a review is written, Enter and Comment post nothing on their own', async () => {
  const h = host()
  const view = await openPull(h)
  await view.press({ type: 'Button', text: 'Review…' })
  await view.type({ label: 'Comment' }, 'Close the writer.', { submit: true })
  assert.equal(h.count('pull.comment'), 0)
  assert.equal(view.find({ type: 'Button', text: 'Comment' })?.disabled, true)
  assert.equal(view.valueOf({ label: 'Comment' }), 'Close the writer.')
  await view.unmount()
})

test('canReview: approve may be empty, the rest need text, and your own takes only a comment', () => {
  const theirs = pullDetail()
  const own = pullDetail({ author: 'chimeyrock999' })
  assert.deepEqual(
    [canReview(theirs, 'approve', ''), canReview(theirs, 'request_changes', ' '), canReview(theirs, 'request_changes', 'x'), canReview(theirs, 'comment', '')],
    [true, false, true, false]
  )
  assert.deepEqual([canReview(own, 'approve', 'x'), canReview(own, 'request_changes', 'x'), canReview(own, 'comment', 'x')], [false, false, true])
  // A viewer gh could not name owns nothing.
  assert.equal(canReview(pullDetail({ viewer: null, author: null }), 'approve', ''), true)
})

test('on your own pull request only a comment review is offered', async () => {
  const view = await openPull(host({}, () => pullDetail({ author: 'chimeyrock999' })))
  await view.press({ type: 'Button', text: 'Review…' })
  assert.ok(view.find({ text: 'You cannot approve or request changes on your own pull request.' }))
  const options = view.find({ type: 'RadioGroup' })?.props.options as { value: string; disabled?: boolean }[]
  assert.deepEqual(options.map((o) => [o.value, !!o.disabled]), [
    ['comment', false],
    ['approve', true],
    ['request_changes', true]
  ])
  await view.unmount()
})

test("a draft is marked ready for review in one press, and loads again, someone else's too", async () => {
  const h = host({}, () => pullDetail({ state: 'draft', merge: 'draft' }))
  const view = await openPull(h)
  assert.equal(view.find({ type: 'Button', text: 'Convert to draft…' }), null)
  await view.press({ type: 'Button', text: 'Ready for review' })
  assert.deepEqual(h.last('pull.ready'), { number: 124, ready: true })
  assert.equal(h.count('pull.get'), 2)
  await view.unmount()
})

test('an open pull request goes back to draft only once confirmed', async () => {
  const h = host({}, () => pullDetail({ author: 'chimeyrock999' }))
  const view = await openPull(h)
  assert.equal(view.find({ type: 'Button', text: 'Ready for review' }), null)
  await view.press({ type: 'Button', text: 'Convert to draft…' })
  assert.ok(draftBox(view))
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.equal(draftBox(view), null)
  assert.equal(h.count('pull.ready'), 0)
  await view.press({ type: 'Button', text: 'Convert to draft…' })
  await view.press({ type: 'Button', text: 'Convert to draft' })
  assert.deepEqual(h.last('pull.ready'), { number: 124, ready: false })
  assert.equal(draftBox(view), null)
  assert.equal(h.count('pull.get'), 2)
  await view.unmount()
})

test('draft and ready are offered only on a pull request you may edit, while it is open', async () => {
  const buttons = (view: Awaited<ReturnType<typeof mount>>) =>
    [view.find({ type: 'Button', text: 'Ready for review' }), view.find({ type: 'Button', text: 'Convert to draft…' })].filter(Boolean).length
  for (const change of [{ canEdit: false }, { canEdit: false, state: 'draft' as const }, { state: 'closed' as const }, { state: 'merged' as const }]) {
    const view = await openPull(host({}, () => pullDetail(change)))
    assert.equal(buttons(view), 0, JSON.stringify(change))
    await view.unmount()
  }
})

test('a refused convert keeps the box and says why', async () => {
  const view = await openPull(host({ 'pull.ready': failed('gh_failed', 'Pull request is in the merge queue') }, () => pullDetail({ author: 'chimeyrock999' })))
  await view.press({ type: 'Button', text: 'Convert to draft…' })
  await view.press({ type: 'Button', text: 'Convert to draft' })
  assert.ok(says(view, /gh failed/))
  assert.ok(draftBox(view))
  await view.unmount()
})

test('a refused review keeps the text and the box, and says why', async () => {
  const view = await openPull(host({ 'pull.review': failed('gh_failed', 'Can not approve your own pull request') }))
  await view.type({ label: 'Comment' }, 'LGTM')
  await view.press({ type: 'Button', text: 'Review…' })
  await view.press({ type: 'Button', text: 'Submit review' })
  assert.ok(says(view, /gh failed/))
  assert.equal(view.valueOf({ label: 'Comment' }), 'LGTM')
  assert.ok(view.find({ type: 'Button', text: 'Submit review' }))
  await view.unmount()
})

test('a review with no answer may have landed: it says so and loads the pull request again', async () => {
  const h = host({ 'pull.review': () => Promise.reject(hostError('timeout', 'no answer')) })
  const view = await openPull(h)
  await view.type({ label: 'Comment' }, 'Nits.')
  await view.press({ type: 'Button', text: 'Review…' })
  await view.press({ type: 'Button', text: 'Submit review' })
  assert.ok(says(view, /It may have gone through/))
  assert.equal(h.count('pull.get'), 2)
  await view.unmount()
})

test('a reload that finds the pull request merged drops an open review box', async () => {
  let state: PullDetail['state'] = 'open'
  const view = await openPull(host({}, () => pullDetail({ state })))
  await view.press({ type: 'Button', text: 'Review…' })
  state = 'merged'
  await view.press({ label: 'Refresh' })
  assert.equal(view.find({ type: 'Button', text: 'Submit review' }), null)
  await view.unmount()
})

test('a pull request that will not load shows why', async () => {
  const view = await openPull(host({ 'pull.get': failed('not_found', 'Could not resolve to a PullRequest with the number of 124.') }))
  assert.ok(says(view, /Not found on GitHub/))
  await view.unmount()
})

test('a pull request of another repo opens here in its own repo; its checks stay on GitHub', async () => {
  const h = host({ 'repo.links': links([], ['octo/sdk#7']) })
  const view = await openPull(h)
  assert.deepEqual(h.last('pull.get'), { number: 7, repo: 'octo/sdk' })
  assert.equal(view.find({ type: 'Button', text: 'Open in Checks' }), null)
  await view.press({ type: 'Link', text: '1 failing · 1 pending · 4 passed' })
  assert.equal(h.last('orca.show'), undefined)
  await view.press({ type: 'Button', text: 'Review…' })
  await view.select({ label: 'Review' }, 'approve')
  await view.press({ type: 'Button', text: 'Submit review' })
  assert.deepEqual(h.last('pull.review'), { number: 7, event: 'approve', body: '', repo: 'octo/sdk' })
  await view.unmount()
})

test('your own pull request of another repo goes to draft in its own repo', async () => {
  const h = host({ 'repo.links': links([], ['octo/sdk#7']) }, () => pullDetail({ author: 'chimeyrock999' }))
  const view = await openPull(h)
  await view.press({ type: 'Button', text: 'Convert to draft…' })
  await view.press({ type: 'Button', text: 'Convert to draft' })
  assert.deepEqual(h.last('pull.ready'), { number: 7, ready: false, repo: 'octo/sdk' })
  await view.unmount()
})
