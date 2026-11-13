// The Issues tab past the list: an issue's detail, its timeline, and every write, over a mock host
// whose `requests` stand in for src/worker.ts.
import { assert, hostError, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import { commentItem, failed, issueDetail, issueRows, itemPage, pullDetail, repoOk } from './fixtures'
import { backToIssues, loadIssue, mergeTimeline, react } from './issue-store'
import { setRepo } from './store'
import type { IssueDetail, ItemListInput } from './protocol'

const ok = { ok: true } as const

function host(overrides: Record<string, unknown> = {}, detail: () => IssueDetail = () => issueDetail()) {
  const asked: { name: string; input: unknown }[] = []
  const log = <I, O>(name: string, answer: (input: I) => O) => (input: I): O => {
    asked.push({ name, input })
    return answer(input)
  }
  const requests: Record<string, unknown> = {
    'repo.get': () => repoOk,
    'issues.list': (input: ItemListInput) => itemPage(issueRows(3), 3, null, input.state === 'all' ? 0 : 1),
    'issue.get': () => ({ ok: true, issue: detail() }),
    'issue.comment': () => ok,
    'issue.close': () => ok,
    'issue.reopen': () => ok,
    'issue.edit': () => ok,
    'comment.edit': () => ok,
    'comment.delete': () => ok,
    'reaction.set': () => ok,
    'labels.list': { ok: true, names: ['bug', 'export', 'good first issue'] },
    'assignees.list': { ok: true, logins: ['ana', 'chimeyrock999', 'kenji'] },
    ...overrides
  }
  const logged = Object.fromEntries(Object.entries(requests).map(([name, answer]) => [name, log(name, typeof answer === 'function' ? (answer as (i: unknown) => unknown) : () => answer)]))
  return Object.assign(mockHost({ requests: logged }), { asked, last: (name: string) => asked.filter((a) => a.name === name).at(-1)?.input })
}

async function openIssue120(h = host()) {
  const view = await mount(panel, { host: h })
  await view.press({ type: 'ListItem', text: /Login page loops/ })
  return view
}

test('the list: All shows both states, Assignee filters, New issue opens the form', async () => {
  const h = host()
  const view = await mount(panel, { host: h })
  await view.press({ type: 'Button', text: 'All' })
  assert.deepEqual((h.last('issues.list') as ItemListInput).state, 'all')
  await view.press({ label: 'Filter' })
  await view.type({ label: 'Assignee' }, '@me', { submit: true })
  assert.deepEqual((h.last('issues.list') as ItemListInput).filters, { assignee: '@me' })
  await view.press({ label: 'New issue' })
  assert.ok(view.find({ text: 'New issue' }))
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('a row opens the issue: state, labels, assignees, milestone, body and timeline', async () => {
  const h = host()
  const view = await openIssue120(h)
  assert.deepEqual(h.last('issue.get'), { number: 120 })
  assert.ok(view.find({ type: 'Text', text: 'Export CSV drops rows past 10k' }))
  assert.deepEqual(view.findAll({ type: 'Badge' }).map((b) => b.text), ['bug', 'export'])
  assert.ok(view.find({ text: 'chimeyrock999' }))
  assert.ok(view.find({ text: 'v1.9' }))
  // #97 in a comment is a link, images point to GitHub.
  assert.ok(view.findAll({ type: 'Markdown' }).some((m) => /\[#97\]\(https:\/\/github\.com\/octo\/app\/issues\/97\)/.test(String(m.props.content))))
  assert.ok(view.find({ text: 'Images show on GitHub only.' }))
  assert.ok(view.find({ type: 'ListItem', text: /fix: stream CSV export past 10k rows/ }))
  assert.ok(view.find({ type: 'Text', text: 'octo/docs#412' }))
  assert.ok(view.find({ type: 'ListItem', text: /lucia mentioned this/ }))
  assert.ok(view.find({ text: /commented .* · edited/ }))
  await view.press({ label: 'Open on GitHub', type: 'IconButton' })
  assert.deepEqual(h.callsOf('shell.openExternal').at(-1), { url: 'https://github.com/octo/app/issues/120' })
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.warnings, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('a mention of an issue or pull request here opens it in its tab; another repo opens on GitHub', async () => {
  const h = host({ 'repo.links': { ok: true, issue: null, pull: null }, 'pull.get': () => ({ ok: true, pull: pullDetail() }) })
  const view = await openIssue120(h)
  await view.press({ type: 'ListItem', text: /docs: note the 10k export limit/ })
  assert.deepEqual(h.callsOf('shell.openExternal').at(-1), { url: 'https://github.com/octo/docs/pull/412' })
  await view.press({ type: 'ListItem', text: /Excel export truncates long cells/ })
  assert.deepEqual(h.last('issue.get'), { number: 97 })
  await view.press({ text: '← Back to issues' })
  await view.press({ type: 'ListItem', text: /Login page loops/ })
  await view.press({ type: 'ListItem', text: /fix: stream CSV export past 10k rows/ })
  assert.deepEqual(h.last('pull.get'), { number: 131 })
  assert.equal(view.find({ type: 'Tabs' })?.props.value, 'pulls')
  // The branch has no pull request of its own, so Back leaves this one for none.
  assert.ok(view.find({ type: 'Button', text: '← Back' }))
  // The Issues tab still holds its issue.
  await view.select({ type: 'Tabs' }, 'issues')
  assert.ok(view.find({ text: '← Back to issues' }))
  await view.unmount()
})

test('comments only show edit and delete where GitHub allows them', async () => {
  const view = await openIssue120()
  assert.equal(view.findAll({ label: 'Edit comment' }).length, 1)
  assert.equal(view.findAll({ label: 'Delete comment' }).length, 1)
  await view.unmount()
})

test('Comment sends the text, clears the box and loads the issue again', async () => {
  const h = host()
  const view = await openIssue120(h)
  assert.equal(view.find({ type: 'Button', text: 'Comment' })?.disabled, true)
  await view.type({ label: 'Comment' }, 'Fixed in #131.')
  assert.ok(view.find({ text: 'Close with comment…' }))
  await view.press({ type: 'Button', text: 'Comment' })
  assert.deepEqual(h.last('issue.comment'), { number: 120, body: 'Fixed in #131.' })
  assert.equal(h.asked.filter((a) => a.name === 'issue.get').length, 2)
  assert.equal(view.valueOf({ label: 'Comment' }), '')
  await view.unmount()
})

test('a failed write keeps what was typed and says why', async () => {
  const h = host({ 'issue.comment': () => failed('gh_failed', 'HTTP 422: Validation Failed') })
  const view = await openIssue120(h)
  await view.type({ label: 'Comment' }, 'Too long')
  await view.press({ type: 'Button', text: 'Comment' })
  assert.ok(view.summary().some((l) => /gh failed/.test(l)))
  assert.equal(view.valueOf({ label: 'Comment' }), 'Too long')
  await view.press({ text: 'Dismiss' })
  assert.ok(!view.summary().some((l) => /gh failed/.test(l)))
  await view.unmount()
})

test('Close asks first, with the reason as the button says', async () => {
  const h = host()
  const view = await openIssue120(h)
  await view.press({ text: 'Close issue…' })
  assert.ok(view.summary().some((l) => /Close #120\?/.test(l)))
  assert.equal(h.last('issue.close'), undefined)
  await view.select({ label: 'Reason' }, 'not planned')
  await view.press({ text: 'Close as not planned' })
  assert.deepEqual(h.last('issue.close'), { number: 120, reason: 'not planned' })
  await view.unmount()
})

test('Close with comment sends the comment; a duplicate needs the issue it repeats', async () => {
  const h = host()
  const view = await openIssue120(h)
  await view.type({ label: 'Comment' }, 'Same as the Excel one.')
  await view.press({ text: 'Close with comment…' })
  assert.ok(view.summary().some((l) => /Close #120 with comment\?/.test(l)))
  await view.select({ label: 'Reason' }, 'duplicate')
  assert.equal(view.find({ text: 'Close as duplicate' })?.disabled, true)
  await view.type({ label: 'Duplicate of' }, '#97')
  await view.press({ text: 'Close as duplicate' })
  assert.deepEqual(h.last('issue.close'), { number: 120, reason: 'duplicate', duplicateOf: 97, comment: 'Same as the Excel one.' })
  await view.unmount()
})

test('Cancel closes nothing', async () => {
  const h = host()
  const view = await openIssue120(h)
  await view.press({ text: 'Close issue…' })
  await view.press({ type: 'Button', text: 'Cancel' })
  assert.equal(h.last('issue.close'), undefined)
  assert.ok(view.find({ text: 'Close issue…' }))
  await view.unmount()
})

test('a closed issue offers Reopen, with the comment when one is typed', async () => {
  const h = host({}, () => issueDetail({ state: 'done', closedAt: Date.now(), head: [...issueDetail().head, { kind: 'closed', id: 'CE_1', actor: 'mai-t', createdAt: Date.now(), reason: 'completed' }] }))
  const view = await openIssue120(h)
  assert.ok(view.find({ text: /closed this as completed/ }))
  await view.type({ label: 'Comment' }, 'Still happens on 1.9.')
  await view.press({ text: 'Reopen with comment' })
  assert.deepEqual(h.last('issue.reopen'), { number: 120, comment: 'Still happens on 1.9.' })
  await view.unmount()
})

test('without the right to edit there is no edit, close or label pencil', async () => {
  const view = await openIssue120(host({}, () => issueDetail({ canEdit: false })))
  assert.equal(view.find({ label: 'Edit title and body' }), null)
  assert.equal(view.find({ text: 'Close issue…' }), null)
  assert.equal(view.find({ label: 'Edit labels' }), null)
  await view.unmount()
})

test('editing a comment saves it in place; deleting asks first and removes it', async () => {
  const h = host()
  const view = await openIssue120(h)
  await view.press({ label: 'Edit comment' })
  await view.type({ label: "Edit chimeyrock999's comment" }, 'Fixed in #131 now.', { replace: true })
  await view.press({ text: 'Update comment' })
  assert.deepEqual(h.last('comment.edit'), { id: 1002, body: 'Fixed in #131 now.' })
  assert.ok(view.findAll({ type: 'Markdown' }).some((m) => /Fixed in \[#131\]/.test(String(m.props.content))))
  await view.press({ label: 'Delete comment' })
  assert.ok(view.summary().some((l) => /Delete this comment\?/.test(l)))
  await view.press({ type: 'Button', text: 'Delete' })
  assert.deepEqual(h.last('comment.delete'), { id: 1002 })
  assert.equal(view.findAll({ label: 'Edit comment' }).length, 0)
  // In place: the issue was asked for once only.
  assert.equal(h.asked.filter((a) => a.name === 'issue.get').length, 1)
  await view.unmount()
})

test('Edit sends only what changed', async () => {
  const h = host()
  const view = await openIssue120(h)
  await view.press({ label: 'Edit title and body' })
  await view.type({ label: 'Title' }, 'CSV export stops at 10k rows', { replace: true })
  await view.press({ text: 'Save' })
  assert.deepEqual(h.last('issue.edit'), { number: 120, title: 'CSV export stops at 10k rows' })
  await view.unmount()
})

test('a body cut to fit is not edited here', async () => {
  const view = await openIssue120(host({}, () => issueDetail({ truncated: true })))
  assert.ok(view.find({ text: 'Read it all on GitHub' }))
  await view.press({ label: 'Edit title and body' })
  assert.equal(view.find({ label: 'Body' })?.disabled, true)
  await view.unmount()
})

test('labels and assignees: pick, then Apply sends what was added and removed', async () => {
  const h = host()
  const view = await openIssue120(h)
  await view.press({ label: 'Edit labels' })
  await view.toggle({ label: 'bug' })
  await view.toggle({ label: 'good first issue' })
  await view.press({ text: 'Apply' })
  assert.deepEqual(h.last('issue.edit'), { number: 120, addLabels: ['good first issue'], removeLabels: ['bug'] })
  await view.press({ label: 'Edit assignees' })
  await view.type({ label: 'Filter people' }, 'ken')
  assert.equal(view.find({ label: 'ana', type: 'Checkbox' }), null)
  await view.type({ label: 'Add by login' }, '@octo-bot', { submit: true })
  await view.press({ text: 'Apply' })
  assert.deepEqual(h.last('issue.edit'), { number: 120, addAssignees: ['octo-bot'], removeAssignees: [] })
  await view.unmount()
})

test('reactions: press to take yours back, ☺ + to add one; a refusal puts it back', async () => {
  let refuse = false
  const h = host({ 'reaction.set': () => (refuse ? failed('gh_failed', 'GitHub reaction failed') : ok) })
  const view = await openIssue120(h)
  await view.press({ type: 'Button', text: '👍 2' })
  assert.deepEqual(h.last('reaction.set'), { subjectId: 'I_120', content: 'THUMBS_UP', on: false })
  assert.ok(view.find({ type: 'Button', text: '👍 1' }))
  await view.press({ type: 'Button', text: '☺ +' })
  await view.press({ type: 'Button', text: '🚀' })
  assert.deepEqual(h.last('reaction.set'), { subjectId: 'I_120', content: 'ROCKET', on: true })
  assert.ok(view.find({ type: 'Button', text: '🚀 1' }))
  refuse = true
  await view.press({ type: 'Button', text: '🎉 1' })
  assert.deepEqual(h.last('reaction.set'), { subjectId: 'IC_1', content: 'HOORAY', on: true })
  assert.ok(view.find({ type: 'Button', text: '🎉 1' }))
  assert.ok(view.summary().some((l) => /gh failed/.test(l)))
  await view.unmount()
})

test('a long timeline: Load more fills the gap until it meets the latest items', async () => {
  const head = [commentItem(1), commentItem(2)]
  const tail = [commentItem(9), commentItem(10)]
  const h = host(
    {
      'issue.timeline': ({ after }: { after: string }) =>
        after === 'c2'
          ? { ok: true, items: [commentItem(3), commentItem(4)], next: 'c4' }
          : { ok: true, items: [commentItem(5), commentItem(9)], next: 'c9' }
    },
    () => issueDetail({ head, tail, next: 'c2', total: 10 })
  )
  const view = await openIssue120(h)
  assert.ok(view.find({ text: 'Load more (6)' }))
  await view.press({ text: 'Load more (6)' })
  assert.deepEqual(h.last('issue.timeline'), { number: 120, after: 'c2' })
  assert.ok(view.find({ text: 'Load more (4)' }))
  await view.press({ text: 'Load more (4)' })
  assert.equal(view.find({ text: /^Load more/ }), null)
  assert.deepEqual(view.findAll({ type: 'Markdown' }).map((m) => m.props.content).slice(1), ['Comment 1', 'Comment 2', 'Comment 3', 'Comment 4', 'Comment 5', 'Comment 9', 'Comment 10'])
  await view.unmount()
})

test('mergeTimeline joins the head and tail where they meet, or at the end', () => {
  const [a, b, c, d] = [1, 2, 3, 4].map((n) => commentItem(n))
  assert.deepEqual(mergeTimeline([a], [d], [b], 'x'), { head: [a, b], tail: [d], next: 'x' })
  assert.deepEqual(mergeTimeline([a], [c, d], [b, c], 'x'), { head: [a, b, c, d], tail: [], next: null })
  assert.deepEqual(mergeTimeline([a], [c, d], [b], null), { head: [a, b, c, d], tail: [], next: null })
})

test('New issue: a title is needed; Create opens the new issue, and Back loads the list again', async () => {
  const h = host({
    'issue.create': () => ({ ok: true, number: 129, url: 'https://github.com/octo/app/issues/129' })
  }, () => issueDetail({ number: 129, title: 'Search ignores accents', head: [], comments: 0, total: 0 }))
  const view = await mount(panel, { host: h })
  await view.press({ label: 'New issue' })
  assert.equal(view.find({ text: 'Create issue' })?.disabled, true)
  await view.type({ label: 'Title' }, 'Search ignores accents')
  await view.type({ label: 'Body' }, 'Searching "cafe" misses "café".')
  await view.press({ label: 'Edit labels' })
  await view.toggle({ label: 'bug' })
  await view.press({ text: 'Apply' })
  await view.press({ text: 'Create issue' })
  assert.deepEqual(h.last('issue.create'), { title: 'Search ignores accents', body: 'Searching "cafe" misses "café".', labels: ['bug'], assignees: [] })
  assert.deepEqual(h.last('issue.get'), { number: 129 })
  assert.ok(view.find({ type: 'Text', text: 'Search ignores accents' }))
  const lists = h.asked.filter((a) => a.name === 'issues.list').length
  await view.press({ text: '← Back to issues' })
  assert.equal(h.asked.filter((a) => a.name === 'issues.list').length, lists + 1)
  await view.unmount()
})

test('Back without a write keeps the list as it was', async () => {
  const h = host()
  const view = await openIssue120(h)
  await view.press({ text: '← Back to issues' })
  assert.equal(h.asked.filter((a) => a.name === 'issues.list').length, 1)
  await view.unmount()
})

test('an issue that will not load shows why, and Retry asks again', async () => {
  let calls = 0
  const h = host({ 'issue.get': () => (++calls === 1 ? failed('not_found', 'Could not resolve to an Issue') : { ok: true, issue: issueDetail() }) })
  const view = await openIssue120(h)
  assert.ok(view.summary().some((l) => /Not found on GitHub/.test(l)))
  await view.press({ text: 'Retry' })
  assert.ok(view.find({ type: 'Text', text: 'Export CSV drops rows past 10k' }))
  await view.unmount()
})

test('Refresh loads the open issue again', async () => {
  const h = host()
  const view = await openIssue120(h)
  await view.press({ label: 'Refresh' })
  assert.equal(h.asked.filter((a) => a.name === 'issue.get').length, 2)
  await view.unmount()
})

test('with no linked issue the tab starts on the list, and a viewed issue is not opened again', async () => {
  const h = host({ 'repo.links': { ok: true, issue: null, pull: null } })
  const view = await openIssue120(h)
  await view.unmount()
  const again = await mount(panel, { host: h })
  assert.equal(h.asked.filter((a) => a.name === 'issue.get').length, 1)
  assert.equal(again.findAll({ type: 'ListItem' }).length, 3)
  await again.unmount()
})

test('a reload while a write is on its way does not lose its answer or lock the box', async () => {
  const h = host({
    'issue.comment': async () => {
      // Refresh lands while gh is still posting the comment.
      await loadIssue()
      return ok
    }
  })
  const view = await openIssue120(h)
  await view.type({ label: 'Comment' }, 'Fixed in #131.')
  await view.press({ type: 'Button', text: 'Comment' })
  assert.equal(view.valueOf({ label: 'Comment' }), '')
  await view.type({ label: 'Comment' }, 'One more.')
  assert.equal(view.find({ type: 'Button', text: 'Comment' })?.disabled, false)
  await view.unmount()
})

test('a comment cut to fit is edited on GitHub, not here', async () => {
  const view = await openIssue120(host({}, () => issueDetail({ head: [commentItem(2, { canEdit: true, canDelete: true, truncated: true })] })))
  assert.equal(view.find({ label: 'Edit comment' }), null)
  assert.ok(view.find({ label: 'Delete comment' }))
  assert.ok(view.find({ text: 'Read it all on GitHub' }))
  await view.unmount()
})

test('Refresh with a picker open asks for its choices again', async () => {
  const h = host()
  const view = await openIssue120(h)
  await view.press({ label: 'Edit labels' })
  await view.press({ label: 'Refresh' })
  assert.equal(h.asked.filter((a) => a.name === 'labels.list').length, 2)
  assert.ok(view.find({ label: 'good first issue', type: 'Checkbox' }))
  await view.unmount()
})

test('two presses before a redraw add and take back, and the count ends where it began', async () => {
  const h = host()
  const view = await openIssue120(h)
  await Promise.all([react('I_120', 'ROCKET'), react('I_120', 'ROCKET')])
  await view.settled()
  assert.deepEqual(h.asked.filter((a) => a.name === 'reaction.set').map((a) => (a.input as { on: boolean }).on), [true, false])
  assert.equal(view.find({ type: 'Button', text: /🚀/ }), null)
  assert.ok(view.find({ type: 'Button', text: '👍 2' }))
  await view.unmount()
})

test('a new issue answered after Back leaves the person on the list', async () => {
  const h = host({
    'issue.create': () => {
      backToIssues()
      return { ok: true, number: 129, url: 'https://github.com/octo/app/issues/129' }
    }
  })
  const view = await mount(panel, { host: h })
  await view.press({ label: 'New issue' })
  await view.type({ label: 'Title' }, 'Search ignores accents')
  await view.press({ text: 'Create issue' })
  assert.equal(h.last('issue.get'), undefined)
  assert.ok(view.findAll({ type: 'ListItem' }).length > 0)
  await view.unmount()
})

test('a workspace made from an issue opens on that issue, once; Back and tab switches stay on the list', async () => {
  const h = host({ 'repo.links': { ok: true, issue: 4, pull: null } })
  const view = await mount(panel, { host: h })
  assert.deepEqual(h.last('issue.get'), { number: 4 })
  assert.ok(view.find({ text: '← Back to issues' }))
  // The list loads behind it, so Back shows it at once.
  assert.equal(h.asked.filter((a) => a.name === 'issues.list').length, 1)
  await view.press({ text: '← Back to issues' })
  await view.select({ type: 'Tabs' }, 'pulls')
  await view.select({ type: 'Tabs' }, 'issues')
  assert.equal(h.asked.filter((a) => a.name === 'issue.get').length, 1)
  assert.equal(view.findAll({ type: 'ListItem' }).length, 3)
  await view.unmount()
})

test('the linked issue waits for the Issues tab', async () => {
  const h = host({ 'repo.links': { ok: true, issue: 4, pull: 13 }, 'pull.get': failed('not_found', 'gone') })
  const view = await mount(panel, { host: h, persisted: { plugin: { tab: 'pulls' } } })
  assert.equal(h.last('issue.get'), undefined)
  await view.select({ type: 'Tabs' }, 'issues')
  assert.deepEqual(h.asked.filter((a) => a.name === 'issue.get').map((a) => a.input), [{ number: 4 }])
  await view.unmount()
})

test('another workspace starts on its own linked issue; no link, or no answer, shows the list', async () => {
  let link: number | null = null
  const h = host({ 'repo.links': () => (link === -1 ? failed('host_failed', 'orca CLI missing') : { ok: true, issue: link, pull: null }) })
  const view = await mount(panel, { host: h })
  assert.equal(h.last('issue.get'), undefined)
  link = 7
  await view.post('repo.changed', { ...repoOk, path: '/code/app-issue-7' })
  assert.deepEqual(h.last('issue.get'), { number: 7 })
  link = -1
  await view.post('repo.changed', { ...repoOk, path: '/code/app-other' })
  assert.equal(view.findAll({ type: 'ListItem' }).length, 3)
  await view.unmount()
})

const lib = { ...repoOk, nameWithOwner: 'octo/lib', url: 'https://github.com/octo/lib', path: '/code/lib' }

test('a new issue answered after the focus moved to another repo opens nothing there', async () => {
  const h = host({
    'issue.create': async () => {
      await setRepo(lib)
      return { ok: true, number: 129, url: 'https://github.com/octo/app/issues/129' }
    }
  })
  const view = await mount(panel, { host: h })
  await view.press({ label: 'New issue' })
  await view.type({ label: 'Title' }, 'Search ignores accents')
  await view.press({ text: 'Create issue' })
  assert.equal(h.last('issue.get'), undefined)
  assert.ok(view.find({ text: 'octo/lib' }))
    await view.unmount()
})

test('an issue answered after the focus moved to another repo is dropped', async () => {
  let calls = 0
  const h = host({
    'issue.get': async () => {
      if (++calls === 1) await setRepo(lib)
      return { ok: true, issue: issueDetail() }
    }
  })
  const view = await openIssue120(h)
  assert.ok(view.find({ text: 'octo/lib' }))
  assert.equal(view.find({ text: '← Back to issues' }), null)
  await view.unmount()
})

test('a write with no answer may have landed: it says so, keeps the text and loads the issue again', async () => {
  const h = host({
    'issue.comment': () => {
      throw hostError('timeout', 'plugin.request timed out')
    }
  })
  const view = await openIssue120(h)
  await view.type({ label: 'Comment' }, 'Fixed in #131.')
  await view.press({ type: 'Button', text: 'Comment' })
  assert.ok(view.summary().some((l) => /It may have gone through/.test(l)))
  assert.equal(view.valueOf({ label: 'Comment' }), 'Fixed in #131.')
  assert.equal(h.asked.filter((a) => a.name === 'issue.get').length, 2)
  await view.unmount()
})

test('a new issue with no answer says it may exist, and Back loads the list again', async () => {
  const h = host({
    'issue.create': () => {
      throw hostError('timeout', 'plugin.request timed out')
    }
  })
  const view = await mount(panel, { host: h })
  await view.press({ label: 'New issue' })
  await view.type({ label: 'Title' }, 'Search ignores accents')
  await view.press({ text: 'Create issue' })
  assert.ok(view.summary().some((l) => /It may have gone through/.test(l)))
  await view.press({ text: '← Back to issues' })
  assert.equal(h.asked.filter((a) => a.name === 'issues.list').length, 2)
  await view.unmount()
})

test('a write that GitHub refused is not called unsure', async () => {
  const view = await openIssue120(host({ 'issue.comment': () => failed('gh_failed', 'HTTP 422') }))
  await view.type({ label: 'Comment' }, 'x')
  await view.press({ type: 'Button', text: 'Comment' })
  assert.ok(!view.summary().some((l) => /It may have gone through/.test(l)))
  await view.unmount()
})

test('a timed-out delete may have landed: the issue is loaded again to show what GitHub has', async () => {
  let gone = false
  const h = host(
    {
      'comment.delete': () => {
        gone = true
        throw hostError('timeout', 'plugin.request timed out')
      }
    },
    () => issueDetail(gone ? { head: issueDetail().head.filter((i) => i.id !== 'IC_2') } : {})
  )
  const view = await openIssue120(h)
  await view.press({ label: 'Delete comment' })
  await view.press({ type: 'Button', text: 'Delete' })
  assert.ok(view.summary().some((l) => /It may have gone through/.test(l)))
  assert.equal(h.asked.filter((a) => a.name === 'issue.get').length, 2)
  assert.equal(view.findAll({ label: 'Delete comment' }).length, 0)
  await view.unmount()
})

test('a timed-out reaction is not flipped back; the issue is loaded again', async () => {
  const h = host({
    'reaction.set': () => {
      throw hostError('timeout', 'plugin.request timed out')
    }
  })
  const view = await openIssue120(h)
  await view.press({ type: 'Button', text: '👍 2' })
  assert.ok(view.summary().some((l) => /It may have gone through/.test(l)))
  assert.equal(h.asked.filter((a) => a.name === 'issue.get').length, 2)
  await view.unmount()
})

test('each workspace shows again what it showed last in this panel run', async () => {
  const other = { ...repoOk, path: '/code/app-other' }
  const h = host({ 'repo.links': { ok: true, issue: null, pull: null } })
  const view = await openIssue120(h)
  // Another workspace starts on its own (here the list), and coming back shows issue 120 again.
  await view.post('repo.changed', other)
  assert.ok(view.find({ type: 'ListItem', text: /Login page loops/ }))
  await view.post('repo.changed', repoOk)
  assert.ok(view.find({ type: 'Text', text: 'Export CSV drops rows past 10k' }))
  // After Back, coming back shows the list, not the link or the issue.
  await view.press({ text: '← Back to issues' })
  await view.post('repo.changed', other)
  await view.post('repo.changed', repoOk)
  assert.equal(view.find({ text: '← Back to issues' }), null)
  await view.unmount()
})
