// The issue handlers over a fake gh: the gh arguments they build and what they make of its answers.
import { assert, test } from 'orca/testing'
import { GhError, type Gh } from '../../../src/worker/gh'
import {
  clip,
  closeIssue,
  commentOn,
  COMMENT_BYTES,
  deleteComment,
  editComment,
  editIssue,
  getIssue,
  issueTimeline,
  listAssignees,
  PAGE_BYTES,
  reopenIssue,
  setReaction
} from '../../../src/worker/issues/issues'

const repo = { nameWithOwner: 'octo/app', path: '/code/app' }

function fakeGh(...answers: unknown[]): Gh & { calls: { args: string[]; cwd?: string; json?: boolean; timeoutMs?: number }[] } {
  const calls: { args: string[]; cwd?: string; json?: boolean; timeoutMs?: number }[] = []
  const gh: Gh = async (args, options) => {
    calls.push({ args, cwd: options?.cwd, json: options?.json, timeoutMs: options?.timeoutMs })
    const next = answers.shift()
    if (next instanceof Error) throw next
    return next
  }
  return Object.assign(gh, { calls })
}

const isGhError = (e: unknown) => e instanceof GhError

function field(args: string[], name: string): string | undefined {
  const i = args.findIndex((a, k) => (args[k - 1] === '-f' || args[k - 1] === '-F') && a.startsWith(`${name}=`))
  return i < 0 ? undefined : args[i].slice(name.length + 1)
}

const group = (content: string, logins: string[], viewerHasReacted = false) => ({
  content,
  viewerHasReacted,
  reactors: { totalCount: logins.length, nodes: logins.map((login) => ({ login })) }
})
const noReactions = ['THUMBS_UP', 'HEART'].map((c) => group(c, []))

function comment(n: number, body = `Comment ${n}`) {
  return {
    __typename: 'IssueComment',
    id: `IC_${n}`,
    databaseId: 1000 + n,
    url: `https://github.com/octo/app/issues/8#issuecomment-${1000 + n}`,
    body,
    createdAt: '2026-11-12T10:00:00Z',
    lastEditedAt: n === 2 ? '2026-11-12T11:00:00Z' : null,
    viewerCanUpdate: n % 2 === 0,
    viewerCanDelete: n % 2 === 0,
    author: { login: 'kenji' },
    reactionGroups: n === 1 ? [group('HOORAY', ['mai-t', 'ana', 'olu', 'lucia']), ...noReactions] : noReactions
  }
}
const edge = (node: unknown, i: number) => ({ cursor: `c${i}`, node })

const mention = {
  __typename: 'CrossReferencedEvent',
  id: 'CRE_1',
  createdAt: '2026-11-12T12:00:00Z',
  actor: { login: 'ana' },
  source: { __typename: 'PullRequest', number: 131, title: 'Stream CSV export', url: 'https://github.com/octo/app/pull/131', state: 'MERGED', isDraft: false, merged: true, repository: { nameWithOwner: 'octo/app' } }
}
const closed = { __typename: 'ClosedEvent', id: 'CE_1', createdAt: '2026-11-12T13:00:00Z', actor: { login: 'mai-t' }, stateReason: 'NOT_PLANNED' }
const reopened = { __typename: 'ReopenedEvent', id: 'RE_1', createdAt: '2026-11-12T14:00:00Z', actor: null }

function issueAnswer(head: unknown[], options: { more?: boolean; tail?: unknown[]; total?: number; body?: string } = {}) {
  return {
    data: {
      repository: {
        issue: {
          id: 'I_8',
          number: 8,
          title: 'Export CSV drops rows past 10k',
          url: 'https://github.com/octo/app/issues/8',
          state: 'CLOSED',
          stateReason: 'COMPLETED',
          body: options.body ?? 'Exporting writes only 10,000 rows. Same as #7.',
          createdAt: '2026-11-10T09:00:00Z',
          closedAt: '2026-11-12T13:00:00Z',
          viewerCanUpdate: true,
          author: { login: 'mai-t' },
          labels: { nodes: [{ name: 'bug' }, { name: 'export' }] },
          assignees: { nodes: [{ login: 'kenji' }] },
          milestone: { title: 'v1.9' },
          comments: { totalCount: 41 },
          reactionGroups: [group('THUMBS_UP', ['ana', 'olu'], true), group('EYES', [])],
          head: {
            totalCount: options.total ?? head.length,
            pageInfo: { hasNextPage: !!options.more, endCursor: options.more ? 'end' : null },
            edges: head.map(edge)
          },
          tail: { edges: (options.tail ?? head.slice(-10)).map((n, i) => ({ cursor: `t${i}`, node: n })) }
        }
      }
    }
  }
}

test('issue.get: one GraphQL query for the issue, its reactions and both ends of the timeline', async () => {
  const gh = fakeGh(issueAnswer([comment(1), mention, closed, reopened, comment(2)]))
  const { issue } = await getIssue(gh, repo, 8)
  const { args, cwd } = gh.calls[0]
  assert.equal(cwd, '/code/app')
  assert.deepEqual(args.slice(0, 2), ['api', 'graphql'])
  assert.deepEqual([field(args, 'owner'), field(args, 'name'), field(args, 'number'), field(args, 'first'), field(args, 'last')], ['octo', 'app', '8', '30', '10'])
  assert.equal(issue.state, 'done')
  assert.deepEqual([issue.labels, issue.assignees, issue.milestone, issue.comments], [['bug', 'export'], ['kenji'], 'v1.9', 41])
  assert.deepEqual(issue.reactions, [{ content: 'THUMBS_UP', count: 2, viewerHasReacted: true, users: ['ana', 'olu'] }])
  assert.deepEqual(issue.head.map((i) => i.kind), ['comment', 'mention', 'closed', 'reopened', 'comment'])
  // A short timeline: the tail repeats the head, so only the head is kept and nothing is left.
  assert.deepEqual([issue.tail, issue.next], [[], null])
})

test('issue.get maps comments, mentions and state events as the panel shows them', async () => {
  const gh = fakeGh(issueAnswer([comment(1), comment(2), mention, closed, reopened]))
  const [first, second, mentioned, close, reopen] = (await getIssue(gh, repo, 8)).issue.head
  assert.deepEqual(first, {
    id: 'IC_1',
    createdAt: Date.parse('2026-11-12T10:00:00Z'),
    kind: 'comment',
    databaseId: 1001,
    url: 'https://github.com/octo/app/issues/8#issuecomment-1001',
    author: 'kenji',
    body: 'Comment 1',
    truncated: false,
    edited: false,
    canEdit: false,
    canDelete: false,
    reactions: [{ content: 'HOORAY', count: 4, viewerHasReacted: false, users: ['mai-t', 'ana', 'olu', 'lucia'] }]
  })
  assert.equal(second.kind === 'comment' && second.edited && second.canEdit && second.canDelete, true)
  assert.deepEqual(mentioned.kind === 'mention' && mentioned.source, {
    type: 'pull',
    number: 131,
    title: 'Stream CSV export',
    url: 'https://github.com/octo/app/pull/131',
    state: 'merged',
    repo: 'octo/app'
  })
  assert.deepEqual([close.kind, 'reason' in close && close.reason, close.kind === 'closed' && close.actor], ['closed', 'not_planned', 'mai-t'])
  assert.deepEqual([reopen.kind, reopen.kind === 'reopened' && reopen.actor], ['reopened', null])
})

test('issue.get on a long timeline: the head pages on, the tail holds the latest items', async () => {
  const head = Array.from({ length: 30 }, (_, i) => comment(i + 1))
  const tail = Array.from({ length: 10 }, (_, i) => comment(i + 90))
  const { issue } = await getIssue(fakeGh(issueAnswer(head, { more: true, tail, total: 99 })), repo, 8)
  assert.equal(issue.head.length, 30)
  assert.equal(issue.next, 'c29')
  assert.deepEqual(issue.tail.map((i) => i.id), tail.map((c) => c.id))
  assert.equal(issue.total, 99)
})

test('a mention by an item this login cannot see is left out', async () => {
  const hidden = { ...mention, id: 'CRE_2', source: null }
  const { issue } = await getIssue(fakeGh(issueAnswer([hidden, comment(1)])), repo, 8)
  assert.deepEqual(issue.head.map((i) => i.id), ['IC_1'])
})

test('long text is cut to stay under the panel message limit, and the page ends early', async () => {
  const big = 'x'.repeat(COMMENT_BYTES * 2)
  const head = Array.from({ length: 30 }, (_, i) => comment(i + 1, big))
  const { issue } = await getIssue(fakeGh(issueAnswer(head, { body: 'é'.repeat(60_000) })), repo, 8)
  assert.equal(issue.truncated, true)
  assert.ok(new TextEncoder().encode(JSON.stringify(issue.body)).length <= 40_000)
  const first = issue.head[0]
  assert.equal(first.kind === 'comment' && first.truncated, true)
  // Each comment is cut to 20 KB, so a page holds what fits in its budget, and goes on from there.
  assert.equal(issue.head.length, Math.floor(PAGE_BYTES / COMMENT_BYTES))
  assert.equal(issue.next, `c${issue.head.length - 1}`)
  assert.ok(JSON.stringify(issue).length < 256 * 1024)
})

test('clip keeps whole characters and says when it cut', () => {
  assert.deepEqual(clip('short', 100), { text: 'short', truncated: false })
  const cut = clip('ééééé', 8)
  assert.equal(cut.truncated, true)
  assert.ok(new TextEncoder().encode(JSON.stringify(cut.text)).length <= 8)
  assert.ok(/^é+$/.test(cut.text))
})

test('a number GitHub has no issue for is not_found', async () => {
  const gh = fakeGh({ data: { repository: { issue: null } } })
  await assert.rejects(getIssue(gh, repo, 11), (e: unknown) => e instanceof GhError && e.code === 'not_found')
})

test('issue.timeline asks for the page after the cursor', async () => {
  const gh = fakeGh({
    data: { repository: { issue: { page: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, edges: [comment(31), comment(32)].map(edge) } } } }
  })
  const page = await issueTimeline(gh, repo, 8, 'c29')
  assert.equal(field(gh.calls[0].args, 'after'), 'c29')
  assert.deepEqual([page.items.map((i) => i.id), page.next], [['IC_31', 'IC_32'], 'c1'])
})

// As POST repos/{owner}/{repo}/issues/{number}/comments answers (abridged).
const POSTED = {
  id: 1003,
  node_id: 'IC_kwDO3',
  html_url: 'https://github.com/octo/app/issues/8#issuecomment-1003',
  body: 'Fixed in #131.',
  user: { login: 'ana' },
  created_at: '2026-11-13T07:00:00Z',
  updated_at: '2026-11-13T07:00:00Z'
}

test('comment, edit and delete: the REST comments API, the comment by id', async () => {
  const gh = fakeGh(JSON.stringify(POSTED), '', '')
  const { comment } = await commentOn(gh, repo, 8, 'Fixed in #131.')
  assert.deepEqual(comment, {
    kind: 'comment',
    id: 'IC_kwDO3',
    databaseId: 1003,
    url: 'https://github.com/octo/app/issues/8#issuecomment-1003',
    author: 'ana',
    body: 'Fixed in #131.',
    truncated: false,
    createdAt: Date.parse('2026-11-13T07:00:00Z'),
    edited: false,
    canEdit: true,
    canDelete: true,
    reactions: []
  })
  await editComment(gh, repo, 1002, '@ana see the fix')
  await deleteComment(gh, repo, 1002)
  assert.deepEqual(gh.calls.map((c) => c.args), [
    ['api', '-X', 'POST', 'repos/octo/app/issues/8/comments', '-f', 'body=Fixed in #131.'],
    ['api', '-X', 'PATCH', 'repos/octo/app/issues/comments/1002', '-f', 'body=@ana see the fix'],
    ['api', '-X', 'DELETE', 'repos/octo/app/issues/comments/1002']
  ])
  assert.ok(gh.calls.every((c) => c.cwd === '/code/app'))
  // Writes get a minute, not gh's 15 s default.
  assert.ok(gh.calls.every((c) => c.timeoutMs === 60_000))
})

test('another repo: gh commands name it with -R, API paths and GraphQL name it as they always do', async () => {
  const other = { nameWithOwner: 'octo/sdk', path: '/code/app', other: true }
  const gh = fakeGh('', '', '', '', { data: { repository: null } })
  await commentOn(gh, other, 45, 'Same here.')
  await closeIssue(gh, other, { number: 45, reason: 'completed' })
  await editIssue(gh, other, { number: 45, addLabels: ['bug'] })
  await editComment(gh, other, 7, 'edited')
  assert.deepEqual(gh.calls.map((c) => c.args), [
    ['api', '-X', 'POST', 'repos/octo/sdk/issues/45/comments', '-f', 'body=Same here.'],
    ['issue', 'close', '45', '--reason', 'completed', '-R', 'octo/sdk'],
    ['issue', 'edit', '45', '--add-label', 'bug', '-R', 'octo/sdk'],
    ['api', '-X', 'PATCH', 'repos/octo/sdk/issues/comments/7', '-f', 'body=edited']
  ])
  // gh still runs in the workspace folder.
  assert.ok(gh.calls.every((c) => c.cwd === '/code/app'))
  await assert.rejects(getIssue(gh, other, 45), isGhError)
  assert.deepEqual([field(gh.calls[4].args, 'owner'), field(gh.calls[4].args, 'name')], ['octo', 'sdk'])
})

test('an empty comment never reaches gh', async () => {
  const gh = fakeGh()
  await assert.rejects(commentOn(gh, repo, 8, '  \n'), isGhError)
  assert.equal(gh.calls.length, 0)
})

test('close takes a reason, a duplicate the issue it repeats, and a comment', async () => {
  const gh = fakeGh('', '', '')
  await closeIssue(gh, repo, { number: 8, reason: 'not planned' })
  await closeIssue(gh, repo, { number: 8, reason: 'completed', comment: 'Done in #131.' })
  await closeIssue(gh, repo, { number: 8, reason: 'duplicate', duplicateOf: 7 })
  assert.deepEqual(gh.calls.map((c) => c.args), [
    ['issue', 'close', '8', '--reason', 'not planned'],
    ['issue', 'close', '8', '--reason', 'completed', '--comment', 'Done in #131.'],
    ['issue', 'close', '8', '--duplicate-of', '7']
  ])
  await assert.rejects(closeIssue(gh, repo, { number: 8, reason: 'duplicate' }), isGhError)
})

test('reopen, with a comment when one is given', async () => {
  const gh = fakeGh('', '')
  await reopenIssue(gh, repo, { number: 8 })
  await reopenIssue(gh, repo, { number: 8, comment: 'Still happens on 1.9.' })
  assert.deepEqual(gh.calls.map((c) => c.args), [
    ['issue', 'reopen', '8'],
    ['issue', 'reopen', '8', '--comment', 'Still happens on 1.9.']
  ])
})

test('edit sends only what changed, one flag per label and login', async () => {
  const gh = fakeGh('', '')
  await editIssue(gh, repo, { number: 8, title: 'CSV export stops at 10k rows', addLabels: ['needs review', 'a,b'], removeLabels: ['bug'], addAssignees: ['ana'], removeAssignees: ['kenji'] })
  await editIssue(gh, repo, { number: 8, body: '' })
  assert.deepEqual(gh.calls.map((c) => c.args), [
    ['issue', 'edit', '8', '--title', 'CSV export stops at 10k rows', '--add-label', 'needs review', '--add-label', 'a,b', '--remove-label', 'bug', '--add-assignee', 'ana', '--remove-assignee', 'kenji'],
    ['issue', 'edit', '8', '--body', '']
  ])
  // Nothing to change runs nothing.
  await editIssue(gh, repo, { number: 8, addLabels: [] })
  assert.equal(gh.calls.length, 2)
})

test('reactions: addReaction or removeReaction on the node id', async () => {
  const gh = fakeGh({ data: {} }, { data: {} }, { errors: [{ message: 'Could not resolve to a node' }] })
  await setReaction(gh, repo, { subjectId: 'IC_1', content: 'ROCKET', on: true })
  await setReaction(gh, repo, { subjectId: 'I_8', content: 'THUMBS_UP', on: false })
  assert.match(field(gh.calls[0].args, 'query') ?? '', /addReaction/)
  assert.match(field(gh.calls[1].args, 'query') ?? '', /removeReaction/)
  assert.deepEqual([field(gh.calls[0].args, 'subjectId'), field(gh.calls[0].args, 'content')], ['IC_1', 'ROCKET'])
  await assert.rejects(setReaction(gh, repo, { subjectId: 'gone', content: 'EYES', on: true }), isGhError)
  await assert.rejects(setReaction(gh, repo, { subjectId: 'I_8', content: 'PARTY' as 'EYES', on: true }), isGhError)
  assert.equal(gh.calls.length, 3)
})

test('assignees: every page, sorted', async () => {
  const gh = fakeGh([[{ login: 'olu' }, { login: 'ana' }], [{ login: 'kenji' }]])
  assert.deepEqual(await listAssignees(gh, repo), { logins: ['ana', 'kenji', 'olu'] })
  assert.deepEqual(gh.calls[0].args, ['api', '--paginate', '--slurp', 'repos/octo/app/assignees?per_page=100'])
})

test('a timeline a little longer than a page: the tail adds what the head missed, and nothing is left', async () => {
  const all = Array.from({ length: 35 }, (_, i) => comment(i + 1))
  const { issue } = await getIssue(fakeGh(issueAnswer(all.slice(0, 30), { more: true, tail: all.slice(25), total: 35 })), repo, 8)
  assert.deepEqual(issue.head.map((i) => i.id), all.map((c) => c.id))
  assert.deepEqual([issue.tail, issue.next], [[], null])
})

test('issue.get says who the viewer is', async () => {
  const answer = issueAnswer([comment(1)]) as { data: Record<string, unknown> }
  answer.data.viewer = { login: 'chimeyrock999' }
  assert.equal((await getIssue(fakeGh(answer), repo, 8)).issue.viewer, 'chimeyrock999')
})

test('a posted comment GitHub answered oddly is still posted: the answer only has no comment', async () => {
  assert.deepEqual(await commentOn(fakeGh('not json'), repo, 8, 'x'), { comment: null })
  assert.deepEqual(await commentOn(fakeGh(JSON.stringify({ id: 'x' })), repo, 8, 'x'), { comment: null })
  await assert.rejects(commentOn(fakeGh(''), repo, 0, 'x'), (e: unknown) => e instanceof GhError && e.code === 'not_found')
  await assert.rejects(commentOn(fakeGh(''), repo, 8, '  '), (e: unknown) => e instanceof GhError && e.code === 'gh_failed')
})
