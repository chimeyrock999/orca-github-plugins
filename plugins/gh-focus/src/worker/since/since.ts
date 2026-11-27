// What changed in the focused workspace while the person was away (src/worker/since/away.ts says
// since when): the linked issues' and pull requests' new comments, reviews and state changes, from
// one GraphQL query that asks GitHub only for timeline items newer than that, and the branch's runs
// that finished since.
import { GhError, type Gh } from '../gh'
import { issueState, pullState, type RepoRef } from '../lists'
import { isRepoName, LINKED_LIMIT, type LinkedRef, type RunRow, type SinceItem } from '../../shared/protocol'

/** Commenters named per item, newest first. */
export const COMMENTERS = 3

const COMMENT = `... on IssueComment { createdAt author { login } }`
const STATE = `... on ClosedEvent { createdAt } ... on ReopenedEvent { createdAt }`
// Different names on issues and pull requests: their timelines are different types.
const ISSUE = `... on Issue {
    number title state stateReason
    ic: timelineItems(since: $since, itemTypes: [ISSUE_COMMENT], last: ${COMMENTERS}) { filteredCount nodes { ${COMMENT} } }
    ie: timelineItems(since: $since, itemTypes: [CLOSED_EVENT, REOPENED_EVENT], last: 10) { nodes { __typename ${STATE} } }
  }`
const PULL = `... on PullRequest {
    number title state isDraft merged
    pc: timelineItems(since: $since, itemTypes: [ISSUE_COMMENT], last: ${COMMENTERS}) { filteredCount nodes { ${COMMENT} } }
    pe: timelineItems(since: $since, itemTypes: [CLOSED_EVENT, REOPENED_EVENT, MERGED_EVENT, PULL_REQUEST_REVIEW], last: 30) {
      nodes { __typename ${STATE} ... on MergedEvent { createdAt } ... on PullRequestReview { state createdAt author { login } } }
    }
  }`

type Event = { __typename: string; createdAt: string; state?: string; author?: { login: string } | null }
type Timeline = { filteredCount?: number; nodes: (Event | null)[] }
type Node = {
  __typename: string
  number: number
  title: string
  state: string
  stateReason?: string | null
  isDraft?: boolean
  merged?: boolean
  ic?: Timeline
  ie?: Timeline
  pc?: Timeline
  pe?: Timeline
}

/** The query: a `repository` per repo with an `issueOrPullRequest` per number and, with `branch`,
 *  the newest pull request of the focused repo (the first) whose head is that branch, in the same
 *  query rather than another gh call (`gh pr view`, which also finds one from a fork's branch).
 *  `$since` (and `$branch`) go as variables. */
export function sinceQuery(repos: string[], numbers: number[][], branch: boolean): string {
  const blocks = repos.map((name, r) => {
    const [owner, repo] = name.split('/')
    const items = (numbers[r] ?? []).map((n) => `n${n}: issueOrPullRequest(number: ${n}) { __typename ${ISSUE} ${PULL} }`)
    if (branch && r === 0) items.push(`branch: ref(qualifiedName: $branch) { associatedPullRequests(first: 1, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { __typename ${PULL} } } }`)
    return `r${r}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {\n    ${items.join('\n    ')}\n  }`
  })
  return `query($since: DateTime!${branch ? ', $branch: String!' : ''}) {\n  viewer { login }\n  ${blocks.join('\n  ')}\n}`
}

const time = (e: Event) => Date.parse(e.createdAt) || 0
const REVIEW: Record<string, SinceItem['reviews'][number]['state']> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', COMMENTED: 'commented' }
const STATES: Record<string, SinceItem['events'][number]> = { ClosedEvent: 'closed', ReopenedEvent: 'reopened', MergedEvent: 'merged' }

/** What changed on one item, or null when nothing did. Timeline items come oldest first. */
export function sinceItem(node: Node, repo: string | null): SinceItem | null {
  const pull = node.__typename === 'PullRequest'
  if (!pull && node.__typename !== 'Issue') return null
  const comments = (pull ? node.pc : node.ic) ?? { nodes: [] }
  const others = ((pull ? node.pe : node.ie)?.nodes ?? []).filter((e): e is Event => !!e)
  const said = comments.nodes.filter((e): e is Event => !!e)
  const commenters = [...new Set(said.map((e) => e.author?.login ?? 'ghost').reverse())].slice(0, COMMENTERS)
  // Each reviewer's latest review, as GitHub's review decision counts them: a comment-only review
  // (an answer in a thread, say) does not undo an approval or a change request. One still pending
  // is only the viewer's draft.
  const latest = new Map<string, SinceItem['reviews'][number]>()
  for (const e of others) {
    const state = e.__typename === 'PullRequestReview' && e.state ? REVIEW[e.state] : undefined
    if (!state) continue
    const author = e.author?.login ?? 'ghost'
    if (state === 'commented' && latest.has(author)) continue
    latest.delete(author)
    latest.set(author, { author, state })
  }
  const events: SinceItem['events'] = []
  for (const e of others) {
    const event = STATES[e.__typename]
    if (event && events.at(-1) !== event) events.push(event)
  }
  // A merge closes the pull request too: GitHub lists both.
  const shown = events.includes('merged') ? events.filter((e) => e !== 'closed') : events
  const count = comments.filteredCount ?? said.length
  const counted = [...said, ...others.filter((e) => STATES[e.__typename] || (e.__typename === 'PullRequestReview' && e.state && REVIEW[e.state]))]
  if (!count && !latest.size && !shown.length) return null
  return {
    kind: pull ? 'pulls' : 'issues',
    number: node.number,
    repo,
    title: node.title,
    state: pull ? pullState(node) : issueState(node),
    comments: count,
    commenters,
    reviews: [...latest.values()].reverse(),
    events: shown,
    at: Math.max(0, ...counted.map(time))
  }
}

type Data = Record<string, unknown> & { viewer?: { login: string } | null }

/** The linked items that changed since `since`, newest first, and the viewer's login. `links`: the
 *  workspace's linked issues and pull requests (`repo` null for the focused repo's); `branch`: the
 *  workspace's branch, whose pull request is asked for as well when none of the focused repo's is
 *  linked. Nothing is asked when there is nothing to ask about. */
export async function sinceItems(
  gh: Gh,
  repo: RepoRef,
  links: { issues: LinkedRef[]; pulls: LinkedRef[] },
  since: number,
  branch: string | null,
  signal?: AbortSignal
): Promise<{ items: SinceItem[]; viewer: string | null }> {
  // The focused repo comes first, so the branch's pull request goes in its block.
  const repos: string[] = [repo.nameWithOwner]
  const numbers: number[][] = [[]]
  for (const ref of [...links.issues, ...links.pulls].slice(0, LINKED_LIMIT)) {
    const name = ref.repo ?? repo.nameWithOwner
    // Owner and repo names go into the query text, so only GitHub's own names pass.
    if (!isRepoName(name) || !Number.isInteger(ref.number) || ref.number < 1) continue
    let r = repos.findIndex((x) => x.toLowerCase() === name.toLowerCase())
    if (r < 0) r = repos.push(name) - 1
    if (!(numbers[r] ??= []).includes(ref.number)) numbers[r].push(ref.number)
  }
  const askBranch = !!branch && !links.pulls.some((p) => p.repo === null)
  if (!askBranch && numbers.every((n) => !n.length)) return { items: [], viewer: null }
  const args = ['api', 'graphql', '-f', `query=${sinceQuery(repos, numbers, askBranch)}`, '-f', `since=${new Date(since).toISOString()}`]
  if (askBranch) args.push('-f', `branch=refs/heads/${branch}`)
  const out = (await gh(args, { cwd: repo.path, signal, json: true, partial: true })) as { data?: Data | null; errors?: { message: string }[] }
  if (!out?.data) {
    const why = out?.errors?.map((e) => e.message).join('; ') || 'no data'
    throw new GhError('gh_failed', `GitHub did not answer what changed: ${why}`)
  }
  const data = out.data
  const items: SinceItem[] = []
  const seen = new Set<string>()
  const add = (node: Node | null | undefined, name: string) => {
    if (!node) return
    const key = `${name.toLowerCase()}#${node.number}`
    if (seen.has(key)) return
    seen.add(key)
    const item = sinceItem(node, name.toLowerCase() === repo.nameWithOwner.toLowerCase() ? null : name)
    if (item) items.push(item)
  }
  repos.forEach((name, r) => {
    const block = data[`r${r}`] as (Record<string, Node | null> & { branch?: { associatedPullRequests?: { nodes: (Node | null)[] } } | null }) | null
    for (const n of numbers[r] ?? []) add(block?.[`n${n}`], name)
    for (const node of block?.branch?.associatedPullRequests?.nodes ?? []) add(node, name)
  })
  return { items: items.sort((a, b) => b.at - a.at), viewer: data.viewer?.login ?? null }
}

/** The runs of a page that finished after `since`, newest first as the page has them. */
export const finishedSince = (rows: RunRow[], since: number): RunRow[] => rows.filter((r) => r.durationMs !== null && r.startedAt + r.durationMs > since)
