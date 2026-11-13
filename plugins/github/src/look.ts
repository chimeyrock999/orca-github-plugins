// How rows and errors read in the panel: a glyph and tone per state, the words around them. Pure,
// so tests pin it without drawing. Tones only, never colours: Orca maps them to the theme.
import type { Tone } from 'orca'
import type {
  CheckCounts,
  ErrorCode,
  IssueRow,
  MergeState,
  PullRow,
  Reaction,
  ReactionGroup,
  ReviewDecision,
  ReviewState,
  RunRow,
  TimelineMention,
  TimelineState
} from './protocol'

export type Look = { glyph: string; tone: Tone; label: string }

// ListItem's icon takes no tone, so the state shows as a tinted glyph in Text instead.
const ISSUE: Record<IssueRow['state'], Look> = {
  open: { glyph: '◉', tone: 'success', label: 'Open' },
  done: { glyph: '✓', tone: 'accent', label: 'Done' },
  not_planned: { glyph: '⊘', tone: 'neutral', label: 'Not planned' }
}
const PULL: Record<PullRow['state'], Look> = {
  open: { glyph: '◉', tone: 'success', label: 'Open' },
  draft: { glyph: '◌', tone: 'neutral', label: 'Draft' },
  merged: { glyph: '✓', tone: 'accent', label: 'Merged' },
  closed: { glyph: '✕', tone: 'danger', label: 'Closed' }
}
const RUN: Record<RunRow['state'], Look> = {
  success: { glyph: '✓', tone: 'success', label: 'Success' },
  failure: { glyph: '✕', tone: 'danger', label: 'Failed' },
  running: { glyph: '◐', tone: 'warning', label: 'In progress' },
  queued: { glyph: '◷', tone: 'warning', label: 'Queued' },
  waiting: { glyph: '◷', tone: 'warning', label: 'Waiting' },
  cancelled: { glyph: '⊘', tone: 'neutral', label: 'Cancelled' },
  skipped: { glyph: '⊖', tone: 'neutral', label: 'Skipped' }
}

export const issueLook = (row: Pick<IssueRow, 'state'>): Look => ISSUE[row.state]
export const pullLook = (row: Pick<PullRow, 'state'>): Look => PULL[row.state]

/** The state glyph of an issue or pull request another one mentions. */
export function sourceLook(source: TimelineMention['source']): Look {
  return source.type === 'pull' ? pullLook({ state: source.state as PullRow['state'] }) : issueLook({ state: source.state as IssueRow['state'] })
}

/** What a closed or reopened event says after its actor: "closed this as not planned". A pull
 *  request's close has no reason. */
export function stateWords(item: TimelineState): { words: string; look: Look } {
  if (item.kind === 'reopened') return { words: 'reopened this', look: ISSUE.open }
  if (item.reason === null) return { words: 'closed this', look: PULL.closed }
  if (item.reason === 'completed') return { words: 'closed this as completed', look: ISSUE.done }
  return { words: `closed this as ${item.reason === 'duplicate' ? 'a duplicate' : 'not planned'}`, look: ISSUE.not_planned }
}

const REVIEW: Record<ReviewState, { words: string; look: Look }> = {
  approved: { words: 'approved these changes', look: { glyph: '✓', tone: 'success', label: 'Approved' } },
  changes_requested: { words: 'requested changes', look: { glyph: '±', tone: 'danger', label: 'Changes requested' } },
  commented: { words: 'reviewed', look: { glyph: '◎', tone: 'neutral', label: 'Reviewed' } },
  dismissed: { words: 'reviewed (dismissed)', look: { glyph: '⊘', tone: 'neutral', label: 'Dismissed' } }
}
/** What a review says after its author, and its glyph. */
export const reviewLook = (state: ReviewState) => REVIEW[state]

// What Orca's Checks tab and pull request page say, so the panel reads alike
// (github-pr-merge-state.ts, pr-check-counts.ts).
const CHECK_WORDS: [keyof CheckCounts, string][] = [
  ['failed', 'failing'],
  ['cancelled', 'cancelled'],
  ['needsAction', 'need action'],
  ['pending', 'pending'],
  ['passed', 'passed'],
  ['neutral', 'neutral']
]

/** "1 failing · 2 pending · 4 passed", by Orca's counting. */
export function checkSummary(counts: CheckCounts): string {
  return CHECK_WORDS.flatMap(([key, words]) => (counts[key] ? [`${count(counts[key])} ${words}`] : [])).join(' · ')
}

/** The glyph of the checks as a whole: failing (or waiting on an action) red, running amber, all
 *  cancelled grey, else green. */
export function checksLook(counts: CheckCounts): Look {
  if (counts.failed || counts.needsAction) return { glyph: '✕', tone: 'danger', label: 'Checks failed' }
  if (counts.pending) return { glyph: '●', tone: 'warning', label: 'Checks pending' }
  if (counts.cancelled) return { glyph: '⊘', tone: 'neutral', label: 'Cancelled' }
  return { glyph: '✓', tone: 'success', label: 'Checks passed' }
}

const MERGE: Record<Exclude<MergeState, 'unstable'>, Look> = {
  clean: { glyph: '✓', tone: 'success', label: 'Able to merge' },
  conflicts: { glyph: '✕', tone: 'danger', label: 'Conflicts' },
  behind: { glyph: '●', tone: 'warning', label: 'Behind' },
  blocked: { glyph: '✕', tone: 'danger', label: 'Blocked' },
  draft: { glyph: '◌', tone: 'neutral', label: 'Draft' },
  unknown: { glyph: '◌', tone: 'neutral', label: 'Checking' }
}

/** Whether it can merge, in Orca's words; `unstable` (mergeable, checks not passing) says how the
 *  checks stand. */
export function mergeLook(state: MergeState, checks: CheckCounts | null = null): Look {
  if (state !== 'unstable') return MERGE[state]
  return checks ? checksLook(checks) : { glyph: '✕', tone: 'danger', label: 'Checks failed' }
}

/** A review decision in Orca's words; with none (no review needed) there is no line. */
export function decisionLook(decision: Exclude<ReviewDecision, null>): Look {
  if (decision === 'approved') return { glyph: '✓', tone: 'success', label: 'Approved' }
  if (decision === 'changes_requested') return { glyph: '±', tone: 'danger', label: 'Changes requested' }
  return { glyph: '●', tone: 'warning', label: 'Approval required' }
}

export const EMOJI: Record<Reaction, string> = {
  THUMBS_UP: '👍',
  THUMBS_DOWN: '👎',
  LAUGH: '😄',
  HOORAY: '🎉',
  CONFUSED: '😕',
  HEART: '❤️',
  ROCKET: '🚀',
  EYES: '👀'
}

/** Who reacted, as GitHub's tooltip says it: "You, ana and 3 others reacted with 👍". The viewer
 *  (`viewer`, or `@me` before GitHub knew the login) reads as You, once. */
export function reactionTip(group: ReactionGroup, viewer: string | null = null): string {
  const names = group.users.filter((u) => u !== '@me' && u !== viewer)
  const shown = [...(group.viewerHasReacted ? ['You'] : []), ...names].slice(0, 3)
  const others = group.count - shown.length
  const who =
    others > 0
      ? `${shown.join(', ')} and ${others} other${others === 1 ? '' : 's'}`
      : shown.length > 1
        ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
        : (shown[0] ?? `${group.count} people`)
  return `${who} reacted with ${EMOJI[group.content]}`
}
export const runLook = (row: Pick<RunRow, 'state'>): Look => RUN[row.state]

/** What happened last to an issue or pull request, and when: "opened", "closed" or "merged". */
export function itemEvent(row: IssueRow | PullRow): { verb: string; at: number } {
  if ('mergedAt' in row && row.state === 'merged' && row.mergedAt) return { verb: 'merged', at: row.mergedAt }
  if (row.state !== 'open' && row.state !== 'draft' && row.closedAt) return { verb: 'closed', at: row.closedAt }
  return { verb: 'opened', at: row.createdAt }
}

/** What started a run, as GitHub's run list says it: "Commit 233b470 pushed by mai-t". */
export function runCause(row: RunRow): string {
  const by = row.actor ? ` by ${row.actor}` : ''
  if (row.event === 'push') return `Commit ${row.sha.slice(0, 7)} pushed${by}`
  if (row.event.startsWith('pull_request')) return `Pull request${row.pullNumber ? ` #${row.pullNumber}` : ''}${by}`
  if (row.event === 'schedule') return 'Scheduled'
  if (row.event === 'workflow_dispatch') return `Manually run${by}`
  return `${row.event.replace(/_/g, ' ')}${by}`
}

/** "1,234": counts as GitHub writes them. */
export const count = (n: number): string => n.toLocaleString('en-US')

/** Page N of M, by the rows GitHub lets anyone reach. */
export function pageLine(page: number, total: number, limit: number | null, pageSize: number): string {
  const reachable = limit === null ? total : Math.min(total, limit)
  const pages = Math.max(1, Math.ceil(reachable / pageSize))
  const capped = limit !== null && total > limit ? ` · first ${count(limit)} shown` : ''
  return `Page ${page} of ${pages} · ${count(total)} total${capped}`
}

/** A moment as the viewer's locale writes a date and time; null stays null. */
export const localTime = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toLocaleString())

/** "57s", "7m 46s", "1h 2m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export type Problem = { title: string; hint: string; tone: Tone }

const PROBLEMS: Record<ErrorCode, Problem> = {
  no_workspace: { title: 'No workspace focused', hint: 'Focus a workspace in Orca to see its GitHub issues, pull requests and runs.', tone: 'neutral' },
  workspace_not_found: { title: 'Workspace not found', hint: 'Orca did not list the focused workspace. Press Retry.', tone: 'warning' },
  ambiguous_workspace: {
    title: 'Several workspaces match',
    hint: 'Open a terminal in it, or pick it here; a pick is remembered for this branch and name.',
    tone: 'warning'
  },
  remote_workspace: { title: 'Workspace is on another machine', hint: 'The panel runs gh on this machine only.', tone: 'warning' },
  host_failed: { title: 'Orca did not answer', hint: 'Press Retry.', tone: 'warning' },
  not_a_repo: { title: 'Not a GitHub repository', hint: 'This folder has no remote on a GitHub host that gh knows.', tone: 'warning' },
  gh_missing: { title: 'GitHub CLI not found', hint: 'Install gh from cli.github.com, run gh auth login, then press Retry.', tone: 'warning' },
  gh_logged_out: { title: 'gh is not logged in', hint: 'Run gh auth login in a terminal, then press Retry.', tone: 'warning' },
  not_found: { title: 'Not found on GitHub', hint: 'It is gone, or this gh login cannot see it.', tone: 'warning' },
  rate_limited: { title: 'GitHub rate limit reached', hint: 'Wait a few minutes, then press Retry.', tone: 'warning' },
  timeout: { title: 'GitHub took too long', hint: 'Press Retry.', tone: 'warning' },
  cancelled: { title: 'Request cancelled', hint: 'Press Retry.', tone: 'neutral' },
  bad_query: { title: 'Search runs with qualifiers', hint: 'For example branch:main status:failure. GitHub cannot search runs by words.', tone: 'warning' },
  gh_failed: { title: 'gh failed', hint: 'Press Retry. The message below is what gh said.', tone: 'danger' },
  unsure: {
    title: 'It may have gone through',
    hint: 'GitHub did not answer in time. Check what is on screen (or the list) before you try again, so nothing is posted twice.',
    tone: 'warning'
  }
}

export const problemOf = (code: ErrorCode): Problem => PROBLEMS[code] ?? PROBLEMS.gh_failed
