// One pull request: its body, checks and timeline (comments, reviews, mentions, closes, reopens and
// the merge) through GraphQL, as for an issue; writes through gh's pr commands. Closing, reopening
// and merging are left to Orca's own pull request views. Comments are edited
// and deleted, and reactions set, by the same requests as an issue's.
import { GhError, type Gh } from './gh'
import { commentOn, editIssue, needText, run } from './issues'
import { pullState, type RepoRef } from './lists'
import {
  PAGE_SIZE,
  type Check,
  type CheckState,
  type IssueEdit,
  type MergeState,
  type PullDetail,
  type ReviewDecision,
  type ReviewEvent,
  type ReviewState,
  type TimelineItem
} from './protocol'
import {
  BODY_BYTES,
  bothEnds,
  clip,
  COMMENT_BYTES,
  COMMON_NODES,
  graphqlData,
  laterPage,
  queryArgs,
  reactionGroups,
  REACTORS,
  TAIL_SIZE,
  timelineItem,
  viewerOf,
  type Connection,
  type GroupJson,
  type Login,
  type NodeJson,
  type ToItem
} from './timeline'

const TIMELINE_NODE = `${COMMON_NODES}
  ... on ClosedEvent { id createdAt actor { login } }
  ... on PullRequestReview { id url body state createdAt submittedAt author { login } comments { totalCount } ${REACTORS} }
  ... on MergedEvent { id createdAt actor { login } commit { oid } mergeRefName }`

const TIMELINE_TYPES =
  'itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, CROSS_REFERENCED_EVENT, CLOSED_EVENT, REOPENED_EVENT, MERGED_EVENT]'

/** The most checks asked for; GitHub's merge box shows the same rollup. */
const CHECKS = 100

const PULL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $last: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number title url state isDraft merged mergedAt body createdAt closedAt viewerCanUpdate
      author { login }
      baseRefName headRefName isCrossRepository headRepositoryOwner { login }
      mergeable mergeStateStatus reviewDecision
      labels(first: 50) { nodes { name } }
      assignees(first: 20) { nodes { login } }
      milestone { title }
      reviewRequests(first: 20) { nodes { requestedReviewer {
        ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { name } } } }
      comments { totalCount }
      ${REACTORS}
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: ${CHECKS}) { totalCount nodes { __typename
        ... on CheckRun { name status conclusion detailsUrl startedAt completedAt checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl } } } } } } }
      head: timelineItems(first: $first, ${TIMELINE_TYPES}) {
        # On a pull request totalCount ignores itemTypes; filteredCount counts the kinds asked for.
        totalCount: filteredCount
        pageInfo { hasNextPage endCursor }
        edges { cursor node { ${TIMELINE_NODE} } }
      }
      tail: timelineItems(last: $last, ${TIMELINE_TYPES}) { edges { cursor node { ${TIMELINE_NODE} } } }
    }
  }
}`

const TIMELINE_QUERY = `query($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      mergedAt
      page: timelineItems(first: $first, after: $after, ${TIMELINE_TYPES}) {
        pageInfo { hasNextPage endCursor }
        edges { cursor node { ${TIMELINE_NODE} } }
      }
    }
  }
}`

type ContextJson = {
  __typename: string
  name?: string
  status?: string
  conclusion?: string | null
  detailsUrl?: string | null
  startedAt?: string | null
  completedAt?: string | null
  checkSuite?: { workflowRun: { workflow: { name: string } } | null } | null
  context?: string
  state?: string
  targetUrl?: string | null
}

type PullJson = {
  id: string
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  merged: boolean
  mergedAt: string | null
  body: string
  createdAt: string
  closedAt: string | null
  viewerCanUpdate: boolean
  author: Login
  baseRefName: string
  headRefName: string
  isCrossRepository: boolean
  headRepositoryOwner: Login
  mergeable: string
  mergeStateStatus: string
  reviewDecision: string | null
  labels: { nodes: { name: string }[] }
  assignees: { nodes: { login: string }[] }
  milestone: { title: string } | null
  reviewRequests: { nodes: { requestedReviewer: { login?: string; name?: string } | null }[] }
  comments: { totalCount: number }
  reactionGroups: GroupJson[]
  commits: { nodes: { commit: { statusCheckRollup: { contexts: { totalCount: number; nodes: ContextJson[] } } | null } }[] }
  head: Connection
  tail: Connection
}

type PullNodeJson = NodeJson & {
  state?: string
  submittedAt?: string | null
  comments?: { totalCount: number }
  commit?: { oid: string } | null
  mergeRefName?: string
}

const REVIEW_STATES: Record<string, ReviewState> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed'
}

/** How far before the merge a close may be stamped and still be the merge's own. */
const CLOSE_SLACK_MS = 60_000

/** Timeline nodes as the panel shows them for a pull request merged at `mergedAt`. */
function pullItem(mergedAt: string | null): ToItem {
  const merge = mergedAt ? Date.parse(mergedAt) : null
  return (json) => {
    const node = json as PullNodeJson | null
    if (!node) return null
    const base = { id: node.id, createdAt: Date.parse(node.createdAt) }
    switch (node.__typename) {
      case 'ClosedEvent':
        // Merging closes the pull request at the same moment, give or take a second, and a merged
        // pull request cannot be closed again; GitHub shows only the merge.
        return merge !== null && base.createdAt >= merge - CLOSE_SLACK_MS ? null : { ...base, kind: 'closed', actor: node.actor?.login ?? null, reason: null }
      case 'PullRequestReview': {
        // A pending review is the viewer's own draft, not submitted yet.
        const state = REVIEW_STATES[node.state ?? '']
        if (!state) return null
        const body = clip(node.body ?? '', COMMENT_BYTES)
        return {
          ...base,
          kind: 'review',
          createdAt: Date.parse(node.submittedAt ?? node.createdAt),
          url: node.url ?? '',
          author: node.author?.login ?? null,
          state,
          body: body.text,
          truncated: body.truncated,
          comments: node.comments?.totalCount ?? 0,
          reactions: reactionGroups(node.reactionGroups)
        }
      }
      case 'MergedEvent':
        return { ...base, kind: 'merged', actor: node.actor?.login ?? null, commit: (node.commit?.oid ?? '').slice(0, 7), into: node.mergeRefName ?? '' }
      default:
        return timelineItem(node)
    }
  }
}

function mergeState(pull: PullJson): MergeState {
  if (pull.mergeable === 'CONFLICTING') return 'conflicts'
  switch (pull.mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return 'clean'
    case 'DIRTY':
      return 'conflicts'
    case 'BEHIND':
      return 'behind'
    case 'BLOCKED':
      return 'blocked'
    case 'UNSTABLE':
      return 'unstable'
    case 'DRAFT':
      return 'draft'
    default:
      return 'unknown'
  }
}

function reviewDecision(value: string | null): ReviewDecision {
  if (value === 'APPROVED') return 'approved'
  if (value === 'CHANGES_REQUESTED') return 'changes_requested'
  return value === 'REVIEW_REQUIRED' ? 'review_required' : null
}

function checkState(c: ContextJson): CheckState {
  if (c.__typename === 'StatusContext') return c.state === 'SUCCESS' ? 'pass' : c.state === 'FAILURE' || c.state === 'ERROR' ? 'fail' : 'pending'
  if (c.status !== 'COMPLETED') return 'pending'
  switch (c.conclusion) {
    case 'SUCCESS':
      return 'pass'
    case 'NEUTRAL':
    case 'SKIPPED':
    case 'STALE':
      return 'skipped'
    default:
      // failure, cancelled, timed out, action required, startup failure
      return 'fail'
  }
}

const ORDER: CheckState[] = ['fail', 'pending', 'pass', 'skipped']

function check(c: ContextJson): Check {
  if (c.__typename === 'StatusContext') return { name: c.context ?? '', state: checkState(c), url: c.targetUrl ?? null, durationMs: null }
  const workflow = c.checkSuite?.workflowRun?.workflow.name
  const started = c.startedAt ? Date.parse(c.startedAt) : NaN
  const done = c.completedAt ? Date.parse(c.completedAt) : NaN
  return {
    name: workflow ? `${workflow} / ${c.name}` : (c.name ?? ''),
    state: checkState(c),
    url: c.detailsUrl ?? null,
    // A skipped job can end before it starts; that is no duration.
    durationMs: c.status === 'COMPLETED' && done >= started ? done - started : null
  }
}

/** The head commit's checks, failing first, as GitHub's merge box lists them. */
function checks(pull: PullJson): { checks: Check[]; checksTotal: number } {
  const contexts = pull.commits.nodes[0]?.commit.statusCheckRollup?.contexts
  if (!contexts) return { checks: [], checksTotal: 0 }
  const all = contexts.nodes.filter((c) => c.__typename === 'CheckRun' || c.__typename === 'StatusContext').map(check)
  const sorted = ORDER.flatMap((state) => all.filter((c) => c.state === state))
  return { checks: sorted, checksTotal: contexts.totalCount }
}

export async function getPull(gh: Gh, repo: RepoRef, number: number, signal?: AbortSignal): Promise<{ pull: PullDetail }> {
  const args = [...queryArgs(PULL_QUERY, repo, number), '-F', `first=${PAGE_SIZE}`, '-F', `last=${TAIL_SIZE}`]
  const out = await gh(args, { cwd: repo.path, signal, json: true })
  const pull = graphqlData<PullJson>(out, 'pullRequest', 'pull request query')
  const body = clip(pull.body ?? '', BODY_BYTES)
  const owner = pull.headRepositoryOwner?.login
  return {
    pull: {
      id: pull.id,
      number: pull.number,
      title: pull.title,
      url: pull.url,
      state: pullState(pull),
      author: pull.author?.login ?? null,
      body: body.text,
      truncated: body.truncated,
      createdAt: Date.parse(pull.createdAt),
      closedAt: pull.closedAt ? Date.parse(pull.closedAt) : null,
      mergedAt: pull.mergedAt ? Date.parse(pull.mergedAt) : null,
      labels: pull.labels.nodes.map((l) => l.name),
      assignees: pull.assignees.nodes.map((a) => a.login),
      milestone: pull.milestone?.title ?? null,
      canEdit: pull.viewerCanUpdate,
      reactions: reactionGroups(pull.reactionGroups),
      comments: pull.comments.totalCount,
      baseRef: pull.baseRefName,
      headRef: pull.isCrossRepository && owner ? `${owner}:${pull.headRefName}` : pull.headRefName,
      merge: mergeState(pull),
      review: reviewDecision(pull.reviewDecision),
      reviewers: pull.reviewRequests.nodes.flatMap((r) => {
        const who = r.requestedReviewer?.login ?? r.requestedReviewer?.name
        return who ? [who] : []
      }),
      ...checks(pull),
      ...bothEnds(pull.head, pull.tail, pullItem(pull.mergedAt)),
      viewer: viewerOf(out)
    }
  }
}

export async function pullTimeline(
  gh: Gh,
  repo: RepoRef,
  number: number,
  after: string,
  signal?: AbortSignal
): Promise<{ items: TimelineItem[]; next: string | null }> {
  const args = [...queryArgs(TIMELINE_QUERY, repo, number), '-F', `first=${PAGE_SIZE}`, '-f', `after=${after}`]
  const out = await gh(args, { cwd: repo.path, signal, json: true })
  const { page, mergedAt } = graphqlData<{ page: Connection; mergedAt: string | null }>(out, 'pullRequest', 'timeline query')
  return laterPage(page, pullItem(mergedAt))
}

export const commentOnPull = (gh: Gh, repo: RepoRef, number: number, body: string, signal?: AbortSignal) => commentOn(gh, repo, number, body, signal, 'pr')
export const editPull = (gh: Gh, repo: RepoRef, input: IssueEdit, signal?: AbortSignal) => editIssue(gh, repo, input, signal, 'pr')

/** The pull request of the branch checked out in the repo's folder, as gh finds it (the latest
 *  one, open or not, fork heads too), or null when there is none or gh cannot tell. */
export async function branchPull(gh: Gh, repo: RepoRef, signal?: AbortSignal): Promise<number | null> {
  try {
    const out = (await gh(['pr', 'view', '--json', 'number'], { cwd: repo.path, signal, json: true })) as { number?: number } | null
    return typeof out?.number === 'number' ? out.number : null
  } catch {
    return null
  }
}

const REVIEW_FLAGS: Record<ReviewEvent, string> = { approve: '--approve', request_changes: '--request-changes', comment: '--comment' }

/** Approve (the body may be empty), request changes or comment (each needs a body, as GitHub does). */
export async function reviewPull(gh: Gh, repo: RepoRef, input: { number: number; event: ReviewEvent; body: string }, signal?: AbortSignal): Promise<object> {
  const flag = REVIEW_FLAGS[input.event]
  if (!flag) throw new GhError('gh_failed', `${String(input.event)} is not a review.`)
  const args = ['pr', 'review', String(input.number), flag]
  if (input.event !== 'approve') args.push('--body', needText(input.body, 'The review'))
  else if (input.body.trim()) args.push('--body', input.body)
  await run(gh, repo, args, signal)
  return {}
}
