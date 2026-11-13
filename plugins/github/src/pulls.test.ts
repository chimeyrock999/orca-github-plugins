// The pull request handlers over a fake gh: the gh arguments they build and what they make of its
// answers. The JSON follows what GitHub's GraphQL API answered for real pull requests.
import { assert, test } from 'orca/testing'
import { GhError, type Gh } from './gh'
import { closePull, commentOnPull, editPull, getPull, pullTimeline, reopenPull, reviewPull } from './pulls'
import { COMMENT_BYTES } from './timeline'

const repo = { nameWithOwner: 'octo/app', path: '/code/app' }

function fakeGh(...answers: unknown[]): Gh & { calls: { args: string[]; cwd?: string; timeoutMs?: number }[] } {
  const calls: { args: string[]; cwd?: string; timeoutMs?: number }[] = []
  const gh: Gh = async (args, options) => {
    calls.push({ args, cwd: options?.cwd, timeoutMs: options?.timeoutMs })
    const next = answers.shift()
    if (next instanceof Error) throw next
    return next
  }
  return Object.assign(gh, { calls })
}

function field(args: string[], name: string): string | undefined {
  const i = args.findIndex((a, k) => (args[k - 1] === '-f' || args[k - 1] === '-F') && a.startsWith(`${name}=`))
  return i < 0 ? undefined : args[i].slice(name.length + 1)
}

const isGhError = (code: string) => (e: unknown) => e instanceof GhError && e.code === code
const edge = (node: unknown, i: number) => ({ cursor: `c${i}`, node })
const group = (content: string, logins: string[]) => ({ content, viewerHasReacted: false, reactors: { totalCount: logins.length, nodes: logins.map((login) => ({ login })) } })

const comment = (n: number, body = `Comment ${n}`) => ({
  __typename: 'IssueComment',
  id: `IC_${n}`,
  databaseId: 1000 + n,
  url: `https://github.com/octo/app/pull/131#issuecomment-${1000 + n}`,
  body,
  createdAt: '2026-11-12T10:00:00Z',
  lastEditedAt: null,
  viewerCanUpdate: true,
  viewerCanDelete: true,
  author: { login: 'kenji' },
  reactionGroups: []
})
const review = (n: number, state: string, change: Record<string, unknown> = {}) => ({
  __typename: 'PullRequestReview',
  id: `PRR_${n}`,
  databaseId: 5000 + n,
  url: `https://github.com/octo/app/pull/131#pullrequestreview-${5000 + n}`,
  state,
  body: `Review ${n}`,
  createdAt: '2026-11-12T11:00:00Z',
  submittedAt: '2026-11-12T11:05:00Z',
  lastEditedAt: null,
  author: { login: 'ana' },
  comments: { totalCount: 2 },
  reactionGroups: [group('HEART', ['olu'])],
  ...change
})
const merged = { __typename: 'MergedEvent', id: 'ME_1', createdAt: '2026-11-13T05:28:59Z', actor: { login: 'ana' }, commit: { oid: 'a1935b0fff8daaf817c3e6fac9c7631dd2896956' }, mergeRefName: 'dev' }
// Merging closes the pull request too, at the same moment (or a second off).
const closedByMerge = { __typename: 'ClosedEvent', id: 'CE_1', createdAt: '2026-11-13T05:29:00Z', actor: { login: 'ana' } }
const closed = { __typename: 'ClosedEvent', id: 'CE_2', createdAt: '2026-11-12T13:00:00Z', actor: { login: 'mai-t' } }
const reopened = { __typename: 'ReopenedEvent', id: 'RE_1', createdAt: '2026-11-12T14:00:00Z', actor: { login: 'mai-t' } }

const checkRun = (name: string, status: string, conclusion: string | null, workflow: string | null = 'CI') => ({
  __typename: 'CheckRun',
  name,
  status,
  conclusion,
  detailsUrl: `https://github.com/octo/app/actions/runs/1/job/${name.length}`,
  startedAt: '2026-11-13T05:05:08Z',
  completedAt: status === 'COMPLETED' ? '2026-11-13T05:05:13Z' : null,
  checkSuite: { workflowRun: workflow ? { workflow: { name: workflow } } : null }
})
const status = (context: string, state: string) => ({ __typename: 'StatusContext', context, state, targetUrl: `https://ci.example.com/${context}`, description: 'Build' })

function pullAnswer(head: unknown[], change: Record<string, unknown> = {}) {
  return {
    data: {
      viewer: { login: 'chimeyrock999' },
      repository: {
        pullRequest: {
          id: 'PR_131',
          number: 131,
          title: 'fix: stream CSV export past 10k rows',
          url: 'https://github.com/octo/app/pull/131',
          state: 'OPEN',
          isDraft: false,
          merged: false,
          mergedAt: null,
          body: 'Streams the rows. Closes #128.',
          createdAt: '2026-11-10T09:00:00Z',
          closedAt: null,
          viewerCanUpdate: true,
          author: { login: 'kenji' },
          baseRefName: 'dev',
          headRefName: 'stream-export',
          isCrossRepository: true,
          headRepositoryOwner: { login: 'kenji' },
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'BLOCKED',
          reviewDecision: 'CHANGES_REQUESTED',
          labels: { nodes: [{ name: 'bug' }] },
          assignees: { nodes: [{ login: 'kenji' }] },
          milestone: null,
          reviewRequests: { nodes: [{ requestedReviewer: null }, { requestedReviewer: { __typename: 'User', login: 'ana' } }, { requestedReviewer: { __typename: 'Team', name: 'core' } }] },
          comments: { totalCount: 1 },
          reactionGroups: [group('ROCKET', ['ana', 'olu'])],
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      totalCount: 6,
                      nodes: [
                        checkRun('lint', 'COMPLETED', 'SUCCESS'),
                        checkRun('test (ubuntu)', 'COMPLETED', 'FAILURE'),
                        checkRun('test (macos)', 'IN_PROGRESS', null),
                        checkRun('GitGuardian Security Checks', 'COMPLETED', 'SKIPPED', null),
                        status('netlify/deploy-preview', 'PENDING'),
                        checkRun('analyze', 'COMPLETED', 'CANCELLED', 'CodeQL')
                      ]
                    }
                  }
                }
              }
            ]
          },
          head: { totalCount: head.length, pageInfo: { hasNextPage: false, endCursor: null }, edges: head.map(edge) },
          tail: { edges: head.slice(-10).map((n, i) => ({ cursor: `t${i}`, node: n })) },
          ...change
        }
      }
    }
  }
}

test('pull.get: one GraphQL query for the pull request, its checks and both ends of the timeline', async () => {
  const gh = fakeGh(pullAnswer([comment(1)]))
  const { pull } = await getPull(gh, repo, 131)
  const args = gh.calls[0].args
  assert.deepEqual(args.slice(0, 2), ['api', 'graphql'])
  assert.deepEqual([field(args, 'owner'), field(args, 'name'), field(args, 'number'), field(args, 'first'), field(args, 'last')], ['octo', 'app', '131', '30', '10'])
  assert.match(field(args, 'query') ?? '', /pullRequest\(number: \$number\)/)
  assert.match(field(args, 'query') ?? '', /PULL_REQUEST_REVIEW/)
  // A pull request's totalCount counts every kind of timeline item, whatever itemTypes says.
  assert.match(field(args, 'query') ?? '', /totalCount: filteredCount/)
  assert.equal(gh.calls[0].cwd, '/code/app')
  assert.deepEqual(
    [pull.state, pull.baseRef, pull.headRef, pull.merge, pull.review, pull.reviewers, pull.labels, pull.viewer, pull.canEdit],
    ['open', 'dev', 'kenji:stream-export', 'blocked', 'changes_requested', ['ana', 'core'], ['bug'], 'chimeyrock999', true]
  )
  assert.equal(pull.reactions[0].count, 2)
  assert.equal(pull.head[0].kind, 'comment')
})

test('checks: failing first, then pending, passed and skipped, each with its run and workflow', async () => {
  const { pull } = await getPull(fakeGh(pullAnswer([])), repo, 131)
  assert.deepEqual(
    pull.checks.map((c) => [c.name, c.state]),
    [
      ['CI / test (ubuntu)', 'fail'],
      ['CodeQL / analyze', 'fail'],
      ['CI / test (macos)', 'pending'],
      ['netlify/deploy-preview', 'pending'],
      ['CI / lint', 'pass'],
      ['GitGuardian Security Checks', 'skipped']
    ]
  )
  assert.equal(pull.checksTotal, 6)
  assert.equal(pull.checks[0].url, 'https://github.com/octo/app/actions/runs/1/job/13')
  assert.equal(pull.checks[0].durationMs, 5000)
  assert.equal(pull.checks.find((c) => c.state === 'pending' && c.name.startsWith('CI'))?.durationMs, null)
  assert.equal(pull.checks.find((c) => c.name === 'netlify/deploy-preview')?.url, 'https://ci.example.com/netlify/deploy-preview')
})

test('a commit with no checks has none, and a skipped check that ends before it starts has no duration', async () => {
  const noRollup = { nodes: [{ commit: { statusCheckRollup: null } }] }
  assert.deepEqual((await getPull(fakeGh(pullAnswer([], { commits: noRollup })), repo, 131)).pull.checks, [])
  const odd = { ...checkRun('skip', 'COMPLETED', 'SKIPPED'), completedAt: '2026-11-13T05:05:06Z' }
  const commits = { nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: 1, nodes: [odd] } } } }] }
  assert.equal((await getPull(fakeGh(pullAnswer([], { commits })), repo, 131)).pull.checks[0].durationMs, null)
})

test('merge state reads GitHub merge state status, and conflicts win', async () => {
  const merge = async (change: Record<string, unknown>) => (await getPull(fakeGh(pullAnswer([], change)), repo, 131)).pull.merge
  assert.equal(await merge({ mergeStateStatus: 'CLEAN' }), 'clean')
  assert.equal(await merge({ mergeStateStatus: 'HAS_HOOKS' }), 'clean')
  assert.equal(await merge({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }), 'conflicts')
  assert.equal(await merge({ mergeStateStatus: 'UNKNOWN', mergeable: 'CONFLICTING' }), 'conflicts')
  assert.equal(await merge({ mergeStateStatus: 'BEHIND' }), 'behind')
  assert.equal(await merge({ mergeStateStatus: 'UNSTABLE' }), 'unstable')
  assert.equal(await merge({ mergeStateStatus: 'DRAFT', isDraft: true }), 'draft')
  assert.equal(await merge({ mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' }), 'unknown')
  const own = (await getPull(fakeGh(pullAnswer([], { isCrossRepository: false, reviewDecision: null })), repo, 131)).pull
  assert.deepEqual([own.headRef, own.review], ['stream-export', null])
})

test('reviews, merges and closes read as GitHub shows them', async () => {
  const head = [review(1, 'APPROVED'), review(2, 'CHANGES_REQUESTED', { body: '' }), review(3, 'COMMENTED'), review(4, 'DISMISSED'), review(5, 'PENDING'), closed, reopened, merged, closedByMerge]
  const answer = pullAnswer(head, { state: 'MERGED', merged: true, mergedAt: '2026-11-13T05:28:59Z', closedAt: '2026-11-13T05:28:59Z' })
  const { pull } = await getPull(fakeGh(answer), repo, 131)
  assert.equal(pull.state, 'merged')
  assert.equal(pull.mergedAt, Date.parse('2026-11-13T05:28:59Z'))
  // A pending review is the viewer's draft, not on GitHub yet; the close by the merge is the merge.
  assert.deepEqual(pull.head.map((i) => i.id), ['PRR_1', 'PRR_2', 'PRR_3', 'PRR_4', 'CE_2', 'RE_1', 'ME_1'])
  const [approved, changes] = pull.head
  assert.deepEqual(approved, {
    kind: 'review',
    id: 'PRR_1',
    url: 'https://github.com/octo/app/pull/131#pullrequestreview-5001',
    author: 'ana',
    state: 'approved',
    body: 'Review 1',
    truncated: false,
    createdAt: Date.parse('2026-11-12T11:05:00Z'),
    comments: 2,
    reactions: [{ content: 'HEART', count: 1, viewerHasReacted: false, users: ['olu'] }]
  })
  assert.deepEqual(changes.kind === 'review' && [changes.state, changes.body], ['changes_requested', ''])
  assert.deepEqual(pull.head.map((i) => (i.kind === 'review' ? i.state : i.kind)), ['approved', 'changes_requested', 'commented', 'dismissed', 'closed', 'reopened', 'merged'])
  assert.deepEqual(pull.head[4], { kind: 'closed', id: 'CE_2', actor: 'mai-t', createdAt: Date.parse('2026-11-12T13:00:00Z'), reason: null })
  assert.deepEqual(pull.head[6], { kind: 'merged', id: 'ME_1', actor: 'ana', createdAt: Date.parse('2026-11-13T05:28:59Z'), commit: 'a1935b0', into: 'dev' })
})

test('review bodies are cut and count against the page budget like comments', async () => {
  const big = 'x'.repeat(COMMENT_BYTES * 2)
  const head = Array.from({ length: 30 }, (_, i) => review(i + 1, 'COMMENTED', { body: big }))
  const { pull } = await getPull(fakeGh(pullAnswer(head)), repo, 131)
  const first = pull.head[0]
  assert.equal(first.kind === 'review' && first.truncated, true)
  assert.ok(pull.head.length < 30)
  assert.ok(pull.next)
  assert.ok(JSON.stringify(pull).length < 256 * 1024)
})

test('a number GitHub has no pull request for is not_found', async () => {
  await assert.rejects(getPull(fakeGh({ data: { repository: { pullRequest: null } } }), repo, 9), isGhError('not_found'))
})

test('pull.timeline asks for the page after the cursor and drops the close by the merge there too', async () => {
  const gh = fakeGh({
    data: {
      repository: {
        pullRequest: {
          mergedAt: '2026-11-13T05:28:59Z',
          page: { pageInfo: { hasNextPage: false, endCursor: null }, edges: [comment(31), merged, closedByMerge].map(edge) }
        }
      }
    }
  })
  const page = await pullTimeline(gh, repo, 131, 'c29')
  assert.equal(field(gh.calls[0].args, 'after'), 'c29')
  assert.deepEqual(page.items.map((i) => i.id), ['IC_31', 'ME_1'])
  assert.equal(page.next, null)
})

test('comment, edit, close and reopen go through gh pr', async () => {
  const gh = fakeGh('https://github.com/octo/app/pull/131#issuecomment-1', '', '', '')
  await commentOnPull(gh, repo, 131, 'Looks good.')
  await editPull(gh, repo, { number: 131, title: 'fix: stream export', addLabels: ['bug'], removeAssignees: ['kenji'] })
  await closePull(gh, repo, { number: 131, comment: 'Superseded by #140.' })
  await reopenPull(gh, repo, { number: 131 })
  assert.deepEqual(
    gh.calls.map((c) => c.args),
    [
      ['pr', 'comment', '131', '--body', 'Looks good.'],
      ['pr', 'edit', '131', '--title', 'fix: stream export', '--add-label', 'bug', '--remove-assignee', 'kenji'],
      ['pr', 'close', '131', '--comment', 'Superseded by #140.'],
      ['pr', 'reopen', '131']
    ]
  )
  assert.ok(gh.calls.every((c) => c.cwd === '/code/app' && c.timeoutMs === 60_000))
})

test('review: approve may be empty; request changes and comment need a body', async () => {
  const gh = fakeGh('', '', '')
  await reviewPull(gh, repo, { number: 131, event: 'approve', body: '' })
  await reviewPull(gh, repo, { number: 131, event: 'request_changes', body: 'Close the writer.' })
  await reviewPull(gh, repo, { number: 131, event: 'comment', body: 'Nits inline.' })
  assert.deepEqual(
    gh.calls.map((c) => c.args),
    [
      ['pr', 'review', '131', '--approve'],
      ['pr', 'review', '131', '--request-changes', '--body', 'Close the writer.'],
      ['pr', 'review', '131', '--comment', '--body', 'Nits inline.']
    ]
  )
  await assert.rejects(reviewPull(gh, repo, { number: 131, event: 'request_changes', body: '  ' }), isGhError('gh_failed'))
  await assert.rejects(reviewPull(gh, repo, { number: 131, event: 'comment', body: '' }), isGhError('gh_failed'))
  await assert.rejects(reviewPull(gh, repo, { number: 131, event: 'merge' as never, body: 'x' }), isGhError('gh_failed'))
  assert.equal(gh.calls.length, 3)
})
