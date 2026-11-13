// The Pull requests tab past the list: a pull request's detail, its checks and timeline, and every
// write (comment, review, close, reopen), over a mock host whose `requests` stand in for src/worker.ts.
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { failed, itemPage, pullDetail, pullRows, repoOk } from './fixtures'
import { canReview } from './pull-store'
import type { ItemListInput, PullDetail } from './protocol'

const ok = { ok: true } as const

function host(overrides: Record<string, unknown> = {}, detail: () => PullDetail = () => pullDetail()) {
  const asked: { name: string; input: unknown }[] = []
  const log = <I, O>(name: string, answer: (input: I) => O) => (input: I): O => {
    asked.push({ name, input })
    return answer(input)
  }
  const requests: Record<string, unknown> = {
    'repo.get': () => repoOk,
    'repo.links': { ok: true, issue: null, pull: null },
    'issues.list': itemPage([], 0, null),
    'pulls.list': () => itemPage(pullRows, 2, null, 1),
    // The pull request asked for, so a row opens its own number.
    'pull.get': ({ number }: { number: number }) => ({ ok: true, pull: { ...detail(), number, url: `https://github.com/octo/app/pull/${number}` } }),
    'pull.comment': () => ok,
    'pull.review': () => ok,
    'pull.close': () => ok,
    'pull.reopen': () => ok,
    'pull.edit': () => ok,
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

async function openPull(h = host()) {
  const view = await mount(panel, { host: h, ...onPulls })
  await view.press({ type: 'ListItem', text: /Fix token refresh loop/ })
  return view
}

const says = (view: Awaited<ReturnType<typeof mount>>, text: RegExp) => view.summary().some((l) => text.test(l))

test('the list: Review requested from me and Draft narrow the search', async () => {
  const h = host()
  const view = await mount(panel, { host: h, ...onPulls })
  await view.press({ label: 'Filter' })
  await view.select({ label: 'Review' }, 'me')
  await view.select({ label: 'Draft' }, 'ready')
  assert.deepEqual((h.last('pulls.list') as ItemListInput).filters, { review: 'me', draft: 'ready' })
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a row opens the pull request: refs, review, merge, reviewers, checks, body and timeline', async () => {
  const h = host()
  const view = await openPull(h)
  assert.deepEqual(h.last('pull.get'), { number: 124 })
  assert.ok(view.find({ type: 'Text', text: 'fix: stream CSV export past 10k rows' }))
  assert.deepEqual(view.findAll({ type: 'Code' }).map((c) => c.text), ['dev', 'kenji:stream-export'])
  assert.ok(view.find({ text: 'Changes requested' }))
  assert.ok(view.find({ text: 'Some checks are not passing' }))
  assert.ok(view.find({ text: 'ana' }))
  const checks = view.find({ type: 'Collapsible' })
  assert.equal(checks?.props.description, '1 failing · 1 pending · 1 passed · 1 skipped')
  // A failing check opens the list.
  assert.equal(view.valueOf({ type: 'Collapsible' }), true)
  await view.press({ type: 'ListItem', text: /CI \/ test \(ubuntu\)/ })
  assert.deepEqual(h.callsOf('shell.openExternal').at(-1), { url: 'https://github.com/octo/app/actions/runs/1/job/2' })
  // Reviews: a box when they say something, with the diff comments on GitHub; one line when not.
  assert.ok(view.find({ text: /^\s*reviewed\b/ }))
  assert.ok(view.find({ text: /2 comments on the diff/ }))
  assert.ok(view.find({ text: /requested changes/ }))
  assert.ok(view.find({ text: /approved these changes/ }))
  assert.ok(view.findAll({ type: 'Markdown' }).some((m) => /\[#120\]\(https:\/\/github\.com\/octo\/app\/issues\/120\)/.test(String(m.props.content))))
  await view.press({ label: 'Open on GitHub', type: 'IconButton' })
  assert.deepEqual(h.callsOf('shell.openExternal').at(-1), { url: 'https://github.com/octo/app/pull/124' })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('passing checks stay folded; no checks shows no box; a merged pull request has no merge line', async () => {
  const passing = pullDetail({ checks: [{ name: 'CI / lint', state: 'pass', url: null, durationMs: 1000 }], checksTotal: 1, merge: 'clean' })
  let view = await openPull(host({}, () => passing))
  assert.equal(view.valueOf({ type: 'Collapsible' }), false)
  assert.ok(view.find({ text: 'Ready to merge' }))
  await view.unmount()
  view = await openPull(host({}, () => pullDetail({ state: 'draft', merge: 'draft', checks: [], checksTotal: 0 })))
  assert.equal(view.find({ type: 'Collapsible' }), null)
  assert.ok(view.find({ text: 'Draft: not ready for review' }))
  await view.unmount()
  view = await openPull(host({}, () => pullDetail({ state: 'merged', merge: 'unknown' })))
  assert.equal(view.find({ text: 'Checking…' }), null)
  assert.equal(view.find({ text: /^Close/ }), null)
  assert.equal(view.find({ text: /^Reopen/ }), null)
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

test('on your own pull request only a comment review is offered', async () => {
  const h = host({}, () => pullDetail({ author: 'chimeyrock999' }))
  const view = await openPull(h)
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

test('Close asks first, then closes with what is typed as a comment; Cancel closes nothing', async () => {
  const h = host()
  const view = await openPull(h)
  await view.press({ type: 'Button', text: 'Close…' })
  assert.ok(says(view, /Close pull request #124\?/))
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.equal(h.count('pull.close'), 0)
  await view.type({ label: 'Comment' }, 'Superseded by #140.')
  await view.press({ type: 'Button', text: 'Close with comment…' })
  assert.ok(says(view, /Close pull request #124 with comment\?/))
  await view.press({ type: 'Button', text: 'Close pull request' })
  assert.deepEqual(h.last('pull.close'), { number: 124, comment: 'Superseded by #140.' })
  assert.equal(view.valueOf({ label: 'Comment' }), '')
  await view.unmount()
})

test('a closed pull request offers Reopen, which asks first too', async () => {
  const h = host({}, () => pullDetail({ state: 'closed', closedAt: Date.UTC(2026, 10, 12) }))
  const view = await openPull(h)
  assert.equal(view.find({ text: 'Review…' }), null)
  await view.press({ type: 'Button', text: 'Reopen…' })
  assert.ok(says(view, /Reopen pull request #124\?/))
  await view.press({ type: 'Button', text: 'Reopen pull request' })
  assert.deepEqual(h.last('pull.reopen'), { number: 124 })
  await view.unmount()
})

test('a refused review keeps the text and the box, and says why', async () => {
  const h = host({ 'pull.review': failed('gh_failed', 'Can not approve your own pull request') })
  const view = await openPull(h)
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

test('Back after a write asks for the list again; without one it keeps it', async () => {
  const h = host()
  const view = await openPull(h)
  await view.press({ text: '← Back to pull requests' })
  assert.equal(h.count('pulls.list'), 1)
  await view.press({ type: 'ListItem', text: /Fix token refresh loop/ })
  await view.type({ label: 'Comment' }, 'Done.')
  await view.press({ type: 'Button', text: 'Comment' })
  await view.press({ text: '← Back to pull requests' })
  assert.equal(h.count('pulls.list'), 2)
  await view.unmount()
})

test('a workspace made from a pull request opens on it when the tab shows', async () => {
  const h = host({ 'repo.links': { ok: true, issue: null, pull: 131 } })
  const view = await mount(panel, { host: h })
  assert.equal(h.count('pull.get'), 0)
  await view.select({ type: 'Tabs' }, 'pulls')
  assert.deepEqual(h.last('pull.get'), { number: 131 })
  assert.ok(view.find({ text: '← Back to pull requests' }))
  await view.press({ text: '← Back to pull requests' })
  await view.select({ type: 'Tabs' }, 'issues')
  await view.select({ type: 'Tabs' }, 'pulls')
  assert.equal(h.count('pull.get'), 1)
  await view.unmount()
})

test('a tab not on screen while the focus went elsewhere and back still shows what it showed', async () => {
  const other = { ...repoOk, path: '/code/app-other' }
  const h = host()
  const view = await openPull(h)
  await view.select({ type: 'Tabs' }, 'issues')
  await view.post('repo.changed', other)
  await view.post('repo.changed', repoOk)
  await view.select({ type: 'Tabs' }, 'pulls')
  assert.ok(view.find({ text: '← Back to pull requests' }))
  assert.deepEqual(h.last('pull.get'), { number: 124 })
  await view.unmount()
})

test('while a review or a close is being asked, Enter and Comment post nothing on their own', async () => {
  const h = host()
  const view = await openPull(h)
  await view.press({ type: 'Button', text: 'Review…' })
  await view.type({ label: 'Comment' }, 'Close the writer.', { submit: true })
  assert.equal(h.count('pull.comment'), 0)
  assert.equal(view.find({ type: 'Button', text: 'Comment' })?.disabled, true)
  assert.equal(view.valueOf({ label: 'Comment' }), 'Close the writer.')
  await view.press({ type: 'Button', text: 'Cancel' })
  await view.press({ type: 'Button', text: 'Close with comment…' })
  await view.submit({ label: 'Comment' })
  assert.equal(h.count('pull.comment') + h.count('pull.close'), 0)
  await view.unmount()
})

test('a reload that finds the pull request merged drops an open review box', async () => {
  let state: PullDetail['state'] = 'open'
  const h = host({}, () => pullDetail({ state }))
  const view = await openPull(h)
  await view.press({ type: 'Button', text: 'Review…' })
  state = 'merged'
  await view.press({ label: 'Refresh' })
  assert.equal(view.find({ type: 'Button', text: 'Submit review' }), null)
  await view.unmount()
})

test('Refresh loads the open pull request again; one that will not load shows why', async () => {
  const h = host()
  const view = await openPull(h)
  await view.press({ label: 'Refresh' })
  assert.equal(h.count('pull.get'), 2)
  await view.unmount()
  const gone = await openPull(host({ 'pull.get': failed('not_found', 'Could not resolve to a PullRequest with the number of 124.') }))
  assert.ok(says(gone, /Not found on GitHub/))
  await gone.unmount()
})
