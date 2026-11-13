// The linked items: which of Orca's links count for the focused repo, the one GraphQL call that
// reads their state, and the agent that is asked to link one.
import { assert, test } from 'orca/testing'
import { GhError, type Gh } from './gh'
import { freeAgent, linkedQuery, linkedRefs, linkedRows, linkPrompt, type AgentRow } from './linked'
import { LINKED_LIMIT, type LinkedRef } from './protocol'

const repo = { nameWithOwner: 'octo/app', path: '/code/app' }

function fakeGh(answer: unknown): Gh & { calls: { args: string[]; cwd?: string; partial?: boolean }[] } {
  const calls: { args: string[]; cwd?: string; partial?: boolean }[] = []
  const gh: Gh = async (args, options) => {
    calls.push({ args, cwd: options?.cwd, partial: options?.partial })
    if (answer instanceof Error) throw answer
    return answer
  }
  return Object.assign(gh, { calls })
}

const query = (gh: { calls: { args: string[] }[] }) => gh.calls[0].args.find((a) => a.startsWith('query='))?.slice('query='.length) ?? ''

test('linkedRefs: issues and pull requests of the workspace, by kind; another repo keeps its name', () => {
  const links = {
    project: 'github:Octo/App',
    items: [
      { type: 'pull' as const, number: 131, repo: 'octo/app', title: 'fix: export', url: 'https://github.com/octo/app/pull/131' },
      { type: 'issue' as const, number: 120, repo: null, title: null, url: null },
      { type: 'issue' as const, number: 45, repo: 'octo/sdk', title: 'Stream writer', url: 'https://github.com/octo/sdk/issues/45' },
      // Linked twice (by URL and by number): once.
      { type: 'issue' as const, number: 120, repo: 'OCTO/app', title: null, url: null }
    ]
  }
  assert.deepEqual(linkedRefs(links, repo), {
    issues: [
      { number: 120, repo: null, title: null, url: null },
      { number: 45, repo: 'octo/sdk', title: 'Stream writer', url: 'https://github.com/octo/sdk/issues/45' }
    ],
    pulls: [{ number: 131, repo: null, title: 'fix: export', url: 'https://github.com/octo/app/pull/131' }]
  })
  // A workspace of another project (a fork, say), or none Orca names: its links are not this repo's.
  assert.deepEqual(linkedRefs({ ...links, project: 'github:octo/fork' }, repo), { issues: [], pulls: [] })
  assert.deepEqual(linkedRefs({ ...links, project: null }, repo), { issues: [], pulls: [] })
  assert.deepEqual(linkedRefs(null, repo), { issues: [], pulls: [] })
})

test('linkedQuery: one repository block per repo, one item per number', () => {
  const q = linkedQuery(['octo/app', 'octo/sdk'], [[120, 98], [45]])
  assert.match(q, /r0: repository\(owner: "octo", name: "app"\)/)
  assert.match(q, /n120: issueOrPullRequest\(number: 120\)/)
  assert.match(q, /r1: repository\(owner: "octo", name: "sdk"\) \{\s+n45: issueOrPullRequest/)
  assert.match(q, /\.\.\. on Issue \{ number title url state stateReason updatedAt \}/)
  assert.match(q, /\.\.\. on PullRequest \{ number title url state isDraft merged updatedAt \}/)
})

const issueNode = (number: number, updatedAt: string, more: Record<string, unknown> = {}) => ({
  __typename: 'Issue',
  number,
  title: `Issue ${number}`,
  url: `https://github.com/octo/app/issues/${number}`,
  state: 'OPEN',
  stateReason: null,
  updatedAt,
  ...more
})

test('linkedRows: one call in the repo folder, newest activity first, state as GitHub has it', async () => {
  const items: LinkedRef[] = [
    { number: 98, repo: null, title: null, url: null },
    { number: 120, repo: null, title: null, url: null },
    { number: 45, repo: 'octo/sdk', title: 'Stream writer', url: 'https://github.com/octo/sdk/issues/45' }
  ]
  const gh = fakeGh({
    data: {
      r0: {
        n98: issueNode(98, '2026-11-10T08:00:00Z', { state: 'CLOSED', stateReason: 'COMPLETED' }),
        n120: issueNode(120, '2026-11-13T08:00:00Z')
      },
      r1: { n45: { ...issueNode(45, '2026-11-12T08:00:00Z', { state: 'CLOSED', stateReason: 'NOT_PLANNED' }), url: 'https://github.com/octo/sdk/issues/45' } }
    }
  })
  const { rows } = await linkedRows(gh, repo, 'issues', items)
  assert.equal(gh.calls.length, 1)
  assert.equal(gh.calls[0].cwd, '/code/app')
  // A missing item must not fail the others.
  assert.equal(gh.calls[0].partial, true)
  assert.match(query(gh), /r0: repository\(owner: "octo", name: "app"\) \{\s+n98: [^]*n120: /)
  assert.deepEqual(
    rows.map((r) => [r.number, r.repo, r.state]),
    [
      [120, null, 'open'],
      [45, 'octo/sdk', 'not_planned'],
      [98, null, 'done']
    ]
  )
  assert.equal(rows[0].updatedAt, Date.parse('2026-11-13T08:00:00Z'))
})

test('linkedRows: pull requests read draft, merged and closed', async () => {
  const pull = (number: number, more: Record<string, unknown>) => ({ ...issueNode(number, '2026-11-13T08:00:00Z'), __typename: 'PullRequest', ...more })
  const gh = fakeGh({ data: { r0: { n1: pull(1, { isDraft: true }), n2: pull(2, { state: 'MERGED', merged: true }), n3: pull(3, { state: 'CLOSED' }) } } })
  const refs = [1, 2, 3].map((number) => ({ number, repo: null, title: null, url: null }))
  const { rows } = await linkedRows(gh, repo, 'pulls', refs)
  assert.deepEqual(
    rows.map((r) => r.state),
    ['draft', 'merged', 'closed']
  )
})

test('linkedRows: an item GitHub has no answer for keeps Orca title and no state, after the rest', async () => {
  const items: LinkedRef[] = [
    { number: 9, repo: null, title: 'Gone issue', url: null },
    { number: 4, repo: 'gone/repo', title: null, url: 'https://github.com/gone/repo/pull/4' },
    { number: 120, repo: null, title: null, url: null }
  ]
  const gh = fakeGh({ data: { r0: { n9: null, n120: issueNode(120, '2026-11-13T08:00:00Z') }, r1: null } })
  const { rows } = await linkedRows(gh, repo, 'pulls', items)
  assert.deepEqual(rows, [
    { number: 120, repo: null, title: 'Issue 120', url: 'https://github.com/octo/app/issues/120', state: 'open', updatedAt: Date.parse('2026-11-13T08:00:00Z') },
    { number: 9, repo: null, title: 'Gone issue', url: 'https://github.com/octo/app/pull/9', state: null, updatedAt: null },
    { number: 4, repo: 'gone/repo', title: '#4', url: 'https://github.com/gone/repo/pull/4', state: null, updatedAt: null }
  ])
})

test('linkedRows: names that do not look like a repo stay out of the query; a call without data fails', async () => {
  const odd = fakeGh({ data: {} })
  const { rows } = await linkedRows(odd, repo, 'issues', [{ number: 3, repo: 'a"){ x }/b', title: null, url: null }])
  assert.equal(odd.calls.length, 0)
  assert.equal(rows[0].state, null)
  await assert.rejects(linkedRows(fakeGh({ errors: [{ message: 'boom' }] }), repo, 'issues', [{ number: 3, repo: null, title: null, url: null }]), (e) => {
    return e instanceof GhError && e.code === 'gh_failed' && /boom/.test(e.message)
  })
  const many = Array.from({ length: LINKED_LIMIT + 5 }, (_, i) => ({ number: i + 1, repo: null, title: null, url: null }))
  const capped = fakeGh({ data: { r0: {} } })
  assert.equal((await linkedRows(capped, repo, 'issues', many)).rows.length, LINKED_LIMIT)
})

test('freeAgent: one waiting or done with a terminal, the one that stopped last; never one at work', () => {
  const agent = (state: string, at: number, terminalId: string | null = `t${at}`): AgentRow => ({ terminalId, title: `Agent ${at}`, agent: 'claude', state, stateStartedAt: at })
  assert.equal(freeAgent([agent('working', 9), agent('done', 2), agent('waiting', 5), agent('blocked', 7)])?.terminalId, 't5')
  assert.equal(freeAgent([agent('working', 1), agent('blocked', 2)]), null)
  assert.equal(freeAgent([agent('done', 3, null)]), null)
  assert.equal(freeAgent([]), null)
})

test('the prompt asks for the link with the command for this repo and kind', () => {
  assert.equal(
    linkPrompt('https://github.com/octo/app', 'pulls'),
    'Link the GitHub pull request this workspace is working on to it in Orca: orca reference add https://github.com/octo/app/pull/<number> --worktree current'
  )
})
