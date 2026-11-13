// One issue: its body and timeline through GraphQL, which pages comments and says what the viewer
// may do; writes through gh's own issue commands, which take label and login names. Comments are
// edited and deleted through the REST API by id, reactions through GraphQL by node id.
import { GhError, type Gh } from '../gh'
import { issueState, repoFlag, type RepoRef } from '../lists'
import { PAGE_SIZE, REACTIONS, type CloseReason, type IssueDetail, type IssueEdit, type Reaction, type TimelineItem } from '../../shared/protocol'
import {
  BODY_BYTES,
  bothEnds,
  clip,
  COMMON_NODES,
  graphqlData,
  laterPage,
  queryArgs,
  reactionGroups,
  REACTORS,
  TAIL_SIZE,
  viewerOf,
  type Connection,
  type GroupJson,
  type Login
} from '../timeline'

export { clip, COMMENT_BYTES, PAGE_BYTES } from '../timeline'

const TIMELINE_NODE = `${COMMON_NODES}
  ... on ClosedEvent { id createdAt actor { login } stateReason }`

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

export async function getIssue(gh: Gh, repo: RepoRef, number: number, signal?: AbortSignal): Promise<{ issue: IssueDetail }> {
  const args = [...queryArgs(ISSUE_QUERY, repo, number), '-F', `first=${PAGE_SIZE}`, '-F', `last=${TAIL_SIZE}`]
  const out = await gh(args, { cwd: repo.path, signal, json: true })
  const issue = graphqlData<IssueJson>(out, 'issue', 'issue query')
  const body = clip(issue.body ?? '', BODY_BYTES)
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
      ...bothEnds(issue.head, issue.tail),
      viewer: viewerOf(out)
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
  const { page } = graphqlData<{ page: Connection }>(await gh(args, { cwd: repo.path, signal, json: true }), 'issue', 'timeline query')
  return laterPage(page)
}

/** Writes get longer than gh's 15 s default: a close with a comment, or an edit of labels and assignees, makes several API calls. */
const WRITE_MS = 60_000

export function run(gh: Gh, repo: RepoRef, args: string[], signal?: AbortSignal): Promise<unknown> {
  const flag = args[0] === 'api' ? [] : repoFlag(repo)
  return gh([...args, ...flag], { cwd: repo.path, signal, timeoutMs: WRITE_MS })
}

export function needText(text: string, what: string): string {
  if (!text.trim()) throw new GhError('gh_failed', `${what} is empty.`)
  return text
}

/** gh's command group: `issue`, or `pr` for a pull request, which takes the same flags here. */
export type Noun = 'issue' | 'pr'

export async function commentOn(gh: Gh, repo: RepoRef, number: number, body: string, signal?: AbortSignal, noun: Noun = 'issue'): Promise<object> {
  await run(gh, repo, [noun, 'comment', String(number), '--body', needText(body, 'The comment')], signal)
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

export async function editIssue(gh: Gh, repo: RepoRef, input: IssueEdit, signal?: AbortSignal, noun: Noun = 'issue'): Promise<object> {
  const args = [noun, 'edit', String(input.number)]
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
