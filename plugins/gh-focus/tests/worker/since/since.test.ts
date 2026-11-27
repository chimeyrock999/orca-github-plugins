// What changed on the linked items since the person left: the one GraphQL query (timeline items
// newer than that only), how its answer reads, and the runs that finished since.
import { assert, test } from 'orca/testing'
import { GhError, type Gh } from '../../../src/worker/gh'
import { finishedSince, sinceItem, sinceItems, sinceQuery } from '../../../src/worker/since/since'
import type { LinkedRef, RunRow } from '../../../src/shared/protocol'

const repo = { nameWithOwner: 'octo/app', path: '/code/app' }
const SINCE = Date.parse('2026-11-27T08:00:00Z')
const at = (min: number) => new Date(SINCE + min * 60_000).toISOString()
const ref = (number: number, other: string | null = null): LinkedRef => ({ number, repo: other, title: null, url: null })

function fakeGh(answer: unknown): Gh & { calls: { args: string[]; partial?: boolean }[] } {
  const calls: { args: string[]; partial?: boolean }[] = []
  const gh: Gh = async (args, options) => {
    calls.push({ args, partial: options?.partial })
    if (answer instanceof Error) throw answer
    return answer
  }
  return Object.assign(gh, { calls })
}

const arg = (gh: { calls: { args: string[] }[] }, name: string) => gh.calls[0].args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)

const issue = (n: number, change: object = {}) => ({
  __typename: 'Issue',
  number: n,
  title: `Issue ${n}`,
  state: 'OPEN',
  stateReason: null,
  ic: { filteredCount: 0, nodes: [] },
  ie: { nodes: [] },
  ...change
})
const pull = (n: number, change: object = {}) => ({
  __typename: 'PullRequest',
  number: n,
  title: `Pull ${n}`,
  state: 'OPEN',
  isDraft: false,
  merged: false,
  pc: { filteredCount: 0, nodes: [] },
  pe: { nodes: [] },
  ...change
})
const comment = (login: string | null, min: number) => ({ createdAt: at(min), author: login ? { login } : null })
const review = (login: string, state: string, min: number) => ({ __typename: 'PullRequestReview', state, createdAt: at(min), author: { login } })
const event = (type: string, min: number) => ({ __typename: type, createdAt: at(min) })

test('sinceQuery: timeline items since $since only, issues and pull requests under their own names, the branch only when asked', () => {
  const q = sinceQuery(['octo/app', 'octo/sdk'], [[8, 21], [45]], true)
  assert.match(q, /^query\(\$since: DateTime!, \$branch: String!\)/)
  assert.match(q, /viewer \{ login \}/)
  assert.match(q, /r0: repository\(owner: "octo", name: "app"\)/)
  assert.match(q, /r1: repository\(owner: "octo", name: "sdk"\) \{\s+n45: issueOrPullRequest\(number: 45\)/)
  assert.equal((q.match(/branch: ref\(qualifiedName: \$branch\)/g) ?? []).length, 1)
  // The newest pull request of the branch, when its name was used before.
  assert.match(q, /associatedPullRequests\(first: 1, orderBy: \{ field: CREATED_AT, direction: DESC \}\)/)
  assert.ok(q.indexOf('branch: ref') < q.indexOf('r1:'))
  for (const name of ['ic', 'ie', 'pc', 'pe']) assert.match(q, new RegExp(`${name}: timelineItems\\(since: \\$since`))
  const plain = sinceQuery(['octo/app'], [[8]], false)
  assert.match(plain, /^query\(\$since: DateTime!\) \{/)
  assert.ok(!plain.includes('$branch'))
})

test('sinceItem: comments (count, newest commenters first), each reviewer’s latest review, and state changes', () => {
  const item = sinceItem(
    pull(21, {
      state: 'MERGED',
      merged: true,
      pc: { filteredCount: 7, nodes: [comment('ana', 1), comment('olu', 2), comment(null, 3)] },
      pe: {
        nodes: [
          review('olu', 'CHANGES_REQUESTED', 1),
          review('ana', 'COMMENTED', 2),
          review('olu', 'APPROVED', 4),
          review('mai', 'PENDING', 5),
          review('kim', 'DISMISSED', 5),
          event('MergedEvent', 6),
          event('ClosedEvent', 6)
        ]
      }
    }),
    null
  )
  assert.deepEqual(item, {
    kind: 'pulls',
    number: 21,
    repo: null,
    title: 'Pull 21',
    state: 'merged',
    comments: 7,
    commenters: ['ghost', 'olu', 'ana'],
    reviews: [
      { author: 'olu', state: 'approved' },
      { author: 'ana', state: 'commented' }
    ],
    events: ['merged'],
    at: Date.parse(at(6))
  })
})

test('sinceItem: a comment-only review after an approval or a change request keeps it, as GitHub’s review decision does', () => {
  const item = sinceItem(pull(23, { pe: { nodes: [review('olu', 'APPROVED', 1), review('olu', 'COMMENTED', 2), review('ana', 'CHANGES_REQUESTED', 3), review('ana', 'COMMENTED', 4)] } }), null)
  assert.deepEqual(item?.reviews, [
    { author: 'ana', state: 'changes_requested' },
    { author: 'olu', state: 'approved' }
  ])
})

test('sinceItem: an issue closed and reopened says both, in order; one with nothing new is null', () => {
  const item = sinceItem(issue(8, { ie: { nodes: [event('ClosedEvent', 1), event('ReopenedEvent', 2)] } }), 'octo/sdk')
  assert.deepEqual(item && { kind: item.kind, repo: item.repo, events: item.events, state: item.state, at: item.at }, {
    kind: 'issues',
    repo: 'octo/sdk',
    events: ['closed', 'reopened'],
    state: 'open',
    at: Date.parse(at(2))
  })
  assert.equal(sinceItem(issue(9), null), null)
  // A review still pending is the viewer's own draft, not news.
  assert.equal(sinceItem(pull(22, { pe: { nodes: [review('ana', 'PENDING', 1)] } }), null), null)
})

test('sinceItems: one query with since as a variable; changed items newest first, of other repos by name', async () => {
  const gh = fakeGh({
    data: {
      viewer: { login: 'ana' },
      r0: { n8: issue(8, { ic: { filteredCount: 1, nodes: [comment('olu', 1)] } }), n21: pull(21) },
      r1: { n45: issue(45, { ie: { nodes: [event('ClosedEvent', 9)] } }) }
    }
  })
  const out = await sinceItems(gh, repo, { issues: [ref(8), ref(45, 'octo/sdk')], pulls: [ref(21)] }, SINCE, 'feature/x')
  assert.equal(gh.calls.length, 1)
  assert.equal(gh.calls[0].partial, true)
  assert.equal(arg(gh, 'since'), '2026-11-27T08:00:00.000Z')
  // A pull request of the repo is linked: the branch's is not asked for.
  assert.equal(arg(gh, 'branch'), undefined)
  assert.deepEqual(
    out.items.map((i) => [i.repo, i.number]),
    [
      ['octo/sdk', 45],
      [null, 8]
    ]
  )
  assert.equal(out.viewer, 'ana')
})

test('sinceItems: with no pull request of the repo linked, the branch’s comes in the same query, once', async () => {
  const merged = pull(30, { state: 'MERGED', merged: true, pe: { nodes: [event('MergedEvent', 3)] } })
  const gh = fakeGh({ data: { viewer: { login: 'ana' }, r0: { n30: merged, branch: { associatedPullRequests: { nodes: [merged] } } } } })
  const out = await sinceItems(gh, repo, { issues: [ref(30)], pulls: [ref(5, 'octo/sdk')] }, SINCE, 'feature/x')
  assert.equal(arg(gh, 'branch'), 'refs/heads/feature/x')
  assert.deepEqual(
    out.items.map((i) => [i.kind, i.number, i.events]),
    [['pulls', 30, ['merged']]]
  )
})

test('sinceItems: nothing to ask about asks nothing; names GitHub would not take stay out of the query', async () => {
  const none = fakeGh({ data: {} })
  assert.deepEqual(await sinceItems(none, repo, { issues: [], pulls: [] }, SINCE, null), { items: [], viewer: null })
  assert.deepEqual(await sinceItems(none, repo, { issues: [ref(8, 'evil") { x }')], pulls: [] }, SINCE, null), { items: [], viewer: null })
  assert.equal(none.calls.length, 0)
})

test('sinceItems: no data is a failure that says why; an item GitHub has no answer for is left out', async () => {
  const broken = fakeGh({ errors: [{ message: 'Something went wrong' }] })
  await assert.rejects(sinceItems(broken, repo, { issues: [ref(8)], pulls: [] }, SINCE, null), (e: unknown) => e instanceof GhError && /Something went wrong/.test(e.message))
  const partial = fakeGh({ data: { viewer: null, r0: { n8: null } }, errors: [{ message: 'Could not resolve' }] })
  assert.deepEqual(await sinceItems(partial, repo, { issues: [ref(8)], pulls: [] }, SINCE, null), { items: [], viewer: null })
})

test('finishedSince: runs that finished after the absence began; one still going or done before is left out', () => {
  const run = (id: number, startMin: number, durationMin: number | null): RunRow => ({
    id,
    runNumber: id,
    workflow: 'CI',
    title: 'CI',
    url: '',
    state: durationMin === null ? 'running' : 'success',
    event: 'push',
    branch: 'feature/x',
    sha: 'abc1234',
    actor: null,
    pullNumber: null,
    startedAt: SINCE + startMin * 60_000,
    durationMs: durationMin === null ? null : durationMin * 60_000
  })
  const rows = [run(4, 10, null), run(3, 5, 3), run(2, -5, 10), run(1, -20, 10)]
  assert.deepEqual(
    finishedSince(rows, SINCE).map((r) => r.id),
    [3, 2]
  )
})
