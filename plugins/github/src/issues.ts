// One issue: its body and timeline through GraphQL, which pages comments and says what the viewer
// may do; writes through gh's own issue commands, which take label and login names. Comments are
// edited and deleted through the REST API by id, reactions through GraphQL by node id.
import { GhError, type Gh } from './gh'
import { issueState, pullState, type RepoRef } from './lists'
import {
  PAGE_SIZE,
  REACTIONS,
  type CloseReason,
  type IssueCreate,
  type IssueDetail,
  type IssueEdit,
  type Reaction,
  type ReactionGroup,
  type TimelineItem
} from './protocol'

/** The latest timeline items shown below a long issue's Load more, as GitHub does. */
export const TAIL_SIZE = 10
/** Bytes, as JSON, one body or comment may take; past it the text is cut. The issue body gets more. */
export const BODY_BYTES = 40_000
export const COMMENT_BYTES = 20_000
/** Bytes of comment text in a page, and in the tail, so the body, both and the rest stay under the
 *  256 KiB panel message limit. A page ends early once its comments reach it. */
export const PAGE_BYTES = 90_000
export const TAIL_BYTES = 50_000

const REACTORS = `reactionGroups { content viewerHasReacted reactors(first: 3) { totalCount nodes {
  ... on User { login } ... on Bot { login } ... on Organization { login } ... on Mannequin { login } } } }`

const SOURCE = `__typename
  ... on Issue { number title url state stateReason repository { nameWithOwner } }
  ... on PullRequest { number title url state isDraft merged repository { nameWithOwner } }`

const TIMELINE_NODE = `__typename
  ... on IssueComment { id databaseId url body createdAt lastEditedAt viewerCanUpdate viewerCanDelete author { login } ${REACTORS} }
  ... on CrossReferencedEvent { id createdAt actor { login } source { ${SOURCE} } }
  ... on ClosedEvent { id createdAt actor { login } stateReason }
  ... on ReopenedEvent { id createdAt actor { login } }`

const TIMELINE_TYPES = 'itemTypes: [ISSUE_COMMENT, CROSS_REFERENCED_EVENT, CLOSED_EVENT, REOPENED_EVENT]'

const ISSUE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $last: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      id number title url state stateReason body createdAt closedAt viewerCanUpdate
      author { login }
      labels(first: 50) { nodes { name } }
      assignees(first: 20) { nodes { login } }
      milestone { title }
      comments { totalCount }
      ${REACTORS}
      head: timelineItems(first: $first, ${TIMELINE_TYPES}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        edges { cursor node { ${TIMELINE_NODE} } }
      }
      tail: timelineItems(last: $last, ${TIMELINE_TYPES}) { edges { cursor node { ${TIMELINE_NODE} } } }
    }
  }
}`

const TIMELINE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      page: timelineItems(first: $first, after: $after, ${TIMELINE_TYPES}) {
        pageInfo { hasNextPage endCursor }
        edges { cursor node { ${TIMELINE_NODE} } }
      }
    }
  }
}`

type Login = { login: string } | null
type GroupJson = { content: string; viewerHasReacted: boolean; reactors: { totalCount: number; nodes: Login[] } }
type NodeJson = {
  __typename: string
  id: string
  createdAt: string
  databaseId?: number
  url?: string
  body?: string
  lastEditedAt?: string | null
  viewerCanUpdate?: boolean
  viewerCanDelete?: boolean
  author?: Login
  actor?: Login
  reactionGroups?: GroupJson[]
  stateReason?: string | null
  source?: {
    __typename: string
    number: number
    title: string
    url: string
    state: string
    stateReason?: string | null
    isDraft?: boolean
    merged?: boolean
    repository: { nameWithOwner: string }
  } | null
}
type Edge = { cursor: string; node: NodeJson | null }
type Connection = { edges: Edge[]; totalCount?: number; pageInfo?: { hasNextPage: boolean; endCursor: string | null } }
type IssueJson = {
  id: string
  number: number
  title: string
  url: string
  state: string
  stateReason: string | null
  body: string
  createdAt: string
  closedAt: string | null
  viewerCanUpdate: boolean
  author: Login
  labels: { nodes: { name: string }[] }
  assignees: { nodes: { login: string }[] }
  milestone: { title: string } | null
  comments: { totalCount: number }
  reactionGroups: GroupJson[]
  head: Connection
  tail: Connection
}

function ownerName(repo: RepoRef): [string, string] {
  const [owner, name] = repo.nameWithOwner.split('/')
  return [owner, name]
}

/** Bytes `text` takes in a JSON message. */
function jsonBytes(text: string): number {
  return new TextEncoder().encode(JSON.stringify(text)).length
}

/** `text` cut so it takes at most `limit` JSON bytes. */
export function clip(text: string, limit: number): { text: string; truncated: boolean } {
  if (jsonBytes(text) <= limit) return { text, truncated: false }
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (jsonBytes(text.slice(0, mid)) <= limit) low = mid
    else high = mid - 1
  }
  return { text: text.slice(0, low), truncated: true }
}

export function reactionGroups(groups: GroupJson[] | undefined): ReactionGroup[] {
  return (groups ?? [])
    .filter((g) => g.reactors.totalCount > 0 && (REACTIONS as readonly string[]).includes(g.content))
    .map((g) => ({
      content: g.content as Reaction,
      count: g.reactors.totalCount,
      viewerHasReacted: g.viewerHasReacted,
      users: g.reactors.nodes.flatMap((n) => (n?.login ? [n.login] : []))
    }))
}

function closeReason(reason: string | null | undefined): 'completed' | 'not_planned' | 'duplicate' {
  if (reason === 'NOT_PLANNED') return 'not_planned'
  return reason === 'DUPLICATE' ? 'duplicate' : 'completed'
}

/** A timeline node as the panel shows it; null for one it does not (a mention by a deleted item). */
export function timelineItem(node: NodeJson | null): TimelineItem | null {
  if (!node) return null
  const base = { id: node.id, createdAt: Date.parse(node.createdAt) }
  switch (node.__typename) {
    case 'IssueComment': {
      const body = clip(node.body ?? '', COMMENT_BYTES)
      return {
        ...base,
        kind: 'comment',
        databaseId: node.databaseId ?? 0,
        url: node.url ?? '',
        author: node.author?.login ?? null,
        body: body.text,
        truncated: body.truncated,
        edited: !!node.lastEditedAt,
        canEdit: !!node.viewerCanUpdate,
        canDelete: !!node.viewerCanDelete,
        reactions: reactionGroups(node.reactionGroups)
      }
    }
    case 'CrossReferencedEvent': {
      const s = node.source
      if (!s || (s.__typename !== 'Issue' && s.__typename !== 'PullRequest')) return null
      const pull = s.__typename === 'PullRequest'
      return {
        ...base,
        kind: 'mention',
        actor: node.actor?.login ?? null,
        source: {
          type: pull ? 'pull' : 'issue',
          number: s.number,
          title: s.title,
          url: s.url,
          state: pull ? pullState(s) : issueState(s),
          repo: s.repository.nameWithOwner
        }
      }
    }
    case 'ClosedEvent':
      return { ...base, kind: 'closed', actor: node.actor?.login ?? null, reason: closeReason(node.stateReason) }
    case 'ReopenedEvent':
      return { ...base, kind: 'reopened', actor: node.actor?.login ?? null, reason: null }
    default:
      return null
  }
}

/** The items of `edges` while their comment text stays within `budget` bytes (at least one), and
 *  the cursor of the last one taken. */
export function takeWithin(edges: Edge[], budget: number): { items: TimelineItem[]; cursor: string | null; all: boolean } {
  const items: TimelineItem[] = []
  let cursor: string | null = null
  let used = 0
  for (const [i, edge] of edges.entries()) {
    const item = timelineItem(edge.node)
    const size = item?.kind === 'comment' ? jsonBytes(item.body) : 0
    if (i > 0 && used + size > budget) return { items, cursor, all: false }
    used += size
    if (item) items.push(item)
    cursor = edge.cursor
  }
  return { items, cursor, all: true }
}

function graphqlData<T>(out: unknown, what: string): T {
  const answer = out as { data?: { repository?: { issue?: T | null } | null }; errors?: { message: string }[] } | null
  const issue = answer?.data?.repository?.issue
  if (issue) return issue
  const why = answer?.errors?.map((e) => e.message).join('; ')
  throw new GhError(why ? 'gh_failed' : 'not_found', why ? `GitHub ${what} failed: ${why}` : `No issue answered the ${what}.`)
}

function queryArgs(query: string, repo: RepoRef, number: number): string[] {
  const [owner, name] = ownerName(repo)
  return ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`]
}

export async function getIssue(gh: Gh, repo: RepoRef, number: number, signal?: AbortSignal): Promise<{ issue: IssueDetail }> {
  const args = [...queryArgs(ISSUE_QUERY, repo, number), '-F', `first=${PAGE_SIZE}`, '-F', `last=${TAIL_SIZE}`]
  const out = await gh(args, { cwd: repo.path, signal, json: true })
  const issue = graphqlData<IssueJson>(out, 'issue query')
  const viewer = (out as { data?: { viewer?: { login?: string } } }).data?.viewer?.login ?? null
  const body = clip(issue.body ?? '', BODY_BYTES)
  const head = takeWithin(issue.head.edges, PAGE_BYTES)
  const headIds = new Set(head.items.map((i) => i.id))
  const more = !head.all || !!issue.head.pageInfo?.hasNextPage
  // On a short timeline the tail overlaps the head: the head and what the tail adds reach the end.
  const tailEdges = more ? issue.tail.edges : []
  const overlaps = tailEdges.some((e) => e.node && headIds.has(e.node.id))
  const fresh = tailEdges.filter((e) => !(e.node && headIds.has(e.node.id)))
  // The latest items are the ones to keep when the tail is over its budget.
  const taken = takeWithin([...fresh].reverse(), TAIL_BYTES)
  const tail = taken.items.reverse()
  const meets = overlaps && head.all && taken.all
  return {
    issue: {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      state: issueState(issue),
      author: issue.author?.login ?? null,
      body: body.text,
      truncated: body.truncated,
      createdAt: Date.parse(issue.createdAt),
      closedAt: issue.closedAt ? Date.parse(issue.closedAt) : null,
      labels: issue.labels.nodes.map((l) => l.name),
      assignees: issue.assignees.nodes.map((a) => a.login),
      milestone: issue.milestone?.title ?? null,
      canEdit: issue.viewerCanUpdate,
      reactions: reactionGroups(issue.reactionGroups),
      comments: issue.comments.totalCount,
      total: issue.head.totalCount ?? head.items.length,
      // Once the head meets the tail they are one list, as Load more would leave them.
      head: meets ? [...head.items, ...tail] : head.items,
      next: more && !meets ? head.cursor : null,
      tail: meets ? [] : tail,
      viewer
    }
  }
}

export async function issueTimeline(
  gh: Gh,
  repo: RepoRef,
  number: number,
  after: string,
  signal?: AbortSignal
): Promise<{ items: TimelineItem[]; next: string | null }> {
  const args = [...queryArgs(TIMELINE_QUERY, repo, number), '-F', `first=${PAGE_SIZE}`, '-f', `after=${after}`]
  const { page } = graphqlData<{ page: Connection }>(await gh(args, { cwd: repo.path, signal, json: true }), 'timeline query')
  const taken = takeWithin(page.edges, PAGE_BYTES)
  const more = !taken.all || !!page.pageInfo?.hasNextPage
  return { items: taken.items, next: more ? taken.cursor : null }
}

/** Writes get longer than gh's 15 s default: `gh issue create` makes several API calls. */
const WRITE_MS = 60_000

function run(gh: Gh, repo: RepoRef, args: string[], signal?: AbortSignal): Promise<unknown> {
  return gh(args, { cwd: repo.path, signal, timeoutMs: WRITE_MS })
}

function needText(text: string, what: string): string {
  if (!text.trim()) throw new GhError('gh_failed', `${what} is empty.`)
  return text
}

export async function commentOn(gh: Gh, repo: RepoRef, number: number, body: string, signal?: AbortSignal): Promise<object> {
  await run(gh, repo, ['issue', 'comment', String(number), '--body', needText(body, 'The comment')], signal)
  return {}
}

export async function editComment(gh: Gh, repo: RepoRef, id: number, body: string, signal?: AbortSignal): Promise<object> {
  const path = `repos/${repo.nameWithOwner}/issues/comments/${id}`
  await run(gh, repo, ['api', '-X', 'PATCH', path, '-f', `body=${needText(body, 'The comment')}`], signal)
  return {}
}

export async function deleteComment(gh: Gh, repo: RepoRef, id: number, signal?: AbortSignal): Promise<object> {
  await run(gh, repo, ['api', '-X', 'DELETE', `repos/${repo.nameWithOwner}/issues/comments/${id}`], signal)
  return {}
}

export async function closeIssue(
  gh: Gh,
  repo: RepoRef,
  input: { number: number; reason: CloseReason; duplicateOf?: number; comment?: string },
  signal?: AbortSignal
): Promise<object> {
  const args = ['issue', 'close', String(input.number)]
  if (input.reason === 'duplicate') {
    if (!input.duplicateOf) throw new GhError('gh_failed', 'Say which issue this one duplicates.')
    args.push('--duplicate-of', String(input.duplicateOf))
  } else {
    args.push('--reason', input.reason)
  }
  if (input.comment?.trim()) args.push('--comment', input.comment)
  await run(gh, repo, args, signal)
  return {}
}

export async function reopenIssue(gh: Gh, repo: RepoRef, input: { number: number; comment?: string }, signal?: AbortSignal): Promise<object> {
  const args = ['issue', 'reopen', String(input.number)]
  if (input.comment?.trim()) args.push('--comment', input.comment)
  await run(gh, repo, args, signal)
  return {}
}

/** One flag per name: gh splits a flag's value on commas. */
function each(flag: string, names: string[] | undefined): string[] {
  return (names ?? []).filter((n) => n.trim()).flatMap((n) => [flag, n.trim()])
}

export async function editIssue(gh: Gh, repo: RepoRef, input: IssueEdit, signal?: AbortSignal): Promise<object> {
  const args = ['issue', 'edit', String(input.number)]
  if (input.title !== undefined) args.push('--title', needText(input.title, 'The title'))
  if (input.body !== undefined) args.push('--body', input.body)
  args.push(
    ...each('--add-label', input.addLabels),
    ...each('--remove-label', input.removeLabels),
    ...each('--add-assignee', input.addAssignees),
    ...each('--remove-assignee', input.removeAssignees)
  )
  if (args.length === 3) return {}
  await run(gh, repo, args, signal)
  return {}
}

export async function createIssue(gh: Gh, repo: RepoRef, input: IssueCreate, signal?: AbortSignal): Promise<{ number: number; url: string }> {
  const args = ['issue', 'create', '--title', needText(input.title, 'The title'), '--body', input.body]
  args.push(...each('--label', input.labels), ...each('--assignee', input.assignees))
  const out = String(await run(gh, repo, args, signal))
  // gh prints the new issue's URL as its last line.
  const url = out.trim().split('\n').pop()?.trim() ?? ''
  const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1])
  if (!number) throw new GhError('gh_failed', `gh created the issue but printed no URL: ${out.slice(0, 200)}`)
  return { number, url }
}

const REACTION_MUTATION = (on: boolean) => `mutation($subjectId: ID!, $content: ReactionContent!) {
  ${on ? 'addReaction' : 'removeReaction'}(input: { subjectId: $subjectId, content: $content }) { reaction { content } }
}`

export async function setReaction(
  gh: Gh,
  repo: RepoRef,
  input: { subjectId: string; content: Reaction; on: boolean },
  signal?: AbortSignal
): Promise<object> {
  if (!(REACTIONS as readonly string[]).includes(input.content)) throw new GhError('gh_failed', `${input.content} is not a GitHub reaction.`)
  const args = ['api', 'graphql', '-f', `query=${REACTION_MUTATION(input.on)}`, '-f', `subjectId=${input.subjectId}`, '-f', `content=${input.content}`]
  const out = (await gh(args, { cwd: repo.path, signal, json: true, timeoutMs: WRITE_MS })) as { errors?: { message: string }[] } | null
  if (out?.errors?.length) throw new GhError('gh_failed', `GitHub reaction failed: ${out.errors.map((e) => e.message).join('; ')}`)
  return {}
}

/** Logins that can be assigned in the repo, every page of them. */
export async function listAssignees(gh: Gh, repo: RepoRef, signal?: AbortSignal): Promise<{ logins: string[] }> {
  const pages = (await gh(['api', '--paginate', '--slurp', `repos/${repo.nameWithOwner}/assignees?per_page=100`], {
    cwd: repo.path,
    signal,
    json: true
  })) as { login: string }[][]
  const all = Array.isArray(pages) ? pages.flatMap((p) => (Array.isArray(p) ? p.map((u) => u.login) : [])) : []
  return { logins: all.sort((a, b) => a.localeCompare(b)) }
}
