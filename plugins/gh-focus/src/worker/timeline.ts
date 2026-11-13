// What issues and pull requests share: the timeline of comments and events through GraphQL, cut
// to fit the panel message limit, with its start and its end in one query and pages after that.
import { GhError } from './gh'
import { issueState, pullState, type RepoRef } from './lists'
import { REACTIONS, type Reaction, type ReactionGroup, type TimelineItem } from '../shared/protocol'

/** The latest timeline items shown below a long timeline's Load more, as GitHub does. */
export const TAIL_SIZE = 10
/** Bytes, as JSON, one body or comment may take; past it the text is cut. The body gets more. */
export const BODY_BYTES = 40_000
export const COMMENT_BYTES = 20_000
/** Bytes of comment text in a page, and in the tail, so the body, both and the rest stay under the
 *  256 KiB panel message limit. A page ends early once its comments reach it. */
export const PAGE_BYTES = 90_000
export const TAIL_BYTES = 50_000

export const REACTORS = `reactionGroups { content viewerHasReacted reactors(first: 3) { totalCount nodes {
  ... on User { login } ... on Bot { login } ... on Organization { login } ... on Mannequin { login } } } }`

const SOURCE = `__typename
  ... on Issue { number title url state stateReason repository { nameWithOwner } }
  ... on PullRequest { number title url state isDraft merged repository { nameWithOwner } }`

/** Timeline nodes both kinds have: comments, mentions, reopened; how each closes differs. */
export const COMMON_NODES = `__typename
  ... on IssueComment { id databaseId url body createdAt lastEditedAt viewerCanUpdate viewerCanDelete author { login } ${REACTORS} }
  ... on CrossReferencedEvent { id createdAt actor { login } source { ${SOURCE} } }
  ... on ReopenedEvent { id createdAt actor { login } }`

export type Login = { login: string } | null
export type GroupJson = { content: string; viewerHasReacted: boolean; reactors: { totalCount: number; nodes: Login[] } }
export type NodeJson = {
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
export type Edge = { cursor: string; node: NodeJson | null }
export type Connection = { edges: Edge[]; totalCount?: number; pageInfo?: { hasNextPage: boolean; endCursor: string | null } }
/** A timeline node as the panel shows it, or null to leave it out. */
export type ToItem = (node: NodeJson | null) => TimelineItem | null

export function ownerName(repo: RepoRef): [string, string] {
  const [owner, name] = repo.nameWithOwner.split('/')
  return [owner, name]
}

/** Bytes `text` takes in a JSON message. */
export function jsonBytes(text: string): number {
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

/** Bytes of text an item brings: a comment's or review's body; events bring none. */
function itemBytes(item: TimelineItem | null): number {
  return item && 'body' in item ? jsonBytes(item.body) : 0
}

/** The items of `edges` while their comment text stays within `budget` bytes (at least one), and
 *  the cursor of the last one taken. */
export function takeWithin(
  edges: Edge[],
  budget: number,
  toItem: ToItem = timelineItem
): { items: TimelineItem[]; cursor: string | null; all: boolean } {
  const items: TimelineItem[] = []
  let cursor: string | null = null
  let used = 0
  for (const [i, edge] of edges.entries()) {
    const item = toItem(edge.node)
    const size = itemBytes(item)
    if (i > 0 && used + size > budget) return { items, cursor, all: false }
    used += size
    if (item) items.push(item)
    cursor = edge.cursor
  }
  return { items, cursor, all: true }
}

/** The start and the end of a timeline from one query, as the panel shows them: `head` from the
 *  start, `next` the cursor after it (null once it meets `tail`), `tail` the latest items. */
export function bothEnds(
  headConnection: Connection,
  tailConnection: Connection,
  toItem: ToItem = timelineItem
): { total: number; head: TimelineItem[]; next: string | null; tail: TimelineItem[] } {
  const head = takeWithin(headConnection.edges, PAGE_BYTES, toItem)
  const headIds = new Set(head.items.map((i) => i.id))
  const more = !head.all || !!headConnection.pageInfo?.hasNextPage
  // On a short timeline the tail overlaps the head: the head and what the tail adds reach the end.
  const tailEdges = more ? tailConnection.edges : []
  const overlaps = tailEdges.some((e) => e.node && headIds.has(e.node.id))
  const fresh = tailEdges.filter((e) => !(e.node && headIds.has(e.node.id)))
  // The latest items are the ones to keep when the tail is over its budget.
  const taken = takeWithin([...fresh].reverse(), TAIL_BYTES, toItem)
  const tail = taken.items.reverse()
  const meets = overlaps && head.all && taken.all
  return {
    total: headConnection.totalCount ?? head.items.length,
    // Once the head meets the tail they are one list, as Load more would leave them.
    head: meets ? [...head.items, ...tail] : head.items,
    next: more && !meets ? head.cursor : null,
    tail: meets ? [] : tail
  }
}

/** A page of the timeline after a cursor. */
export function laterPage(page: Connection, toItem: ToItem = timelineItem): { items: TimelineItem[]; next: string | null } {
  const taken = takeWithin(page.edges, PAGE_BYTES, toItem)
  const more = !taken.all || !!page.pageInfo?.hasNextPage
  return { items: taken.items, next: more ? taken.cursor : null }
}

/** The issue or pull request a GraphQL answer holds, or why there is none. */
export function graphqlData<T>(out: unknown, field: 'issue' | 'pullRequest', what: string): T {
  const answer = out as { data?: { repository?: Record<string, T | null> | null }; errors?: { message: string }[] } | null
  const found = answer?.data?.repository?.[field]
  if (found) return found
  const why = answer?.errors?.map((e) => e.message).join('; ')
  const noun = field === 'issue' ? 'issue' : 'pull request'
  throw new GhError(why ? 'gh_failed' : 'not_found', why ? `GitHub ${what} failed: ${why}` : `No ${noun} answered the ${what}.`)
}

export function queryArgs(query: string, repo: RepoRef, number: number): string[] {
  const [owner, name] = ownerName(repo)
  return ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`]
}

export function viewerOf(out: unknown): string | null {
  return (out as { data?: { viewer?: { login?: string } } }).data?.viewer?.login ?? null
}
