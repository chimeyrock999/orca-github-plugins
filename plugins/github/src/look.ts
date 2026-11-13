// How rows and errors read in the panel: a glyph and tone per state, the words around them. Pure,
// so tests pin it without drawing. Tones only, never colours: Orca maps them to the theme.
import type { Tone } from 'orca'
import type { ErrorCode, IssueRow, PullRow, RunRow } from './protocol'

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
  waiting: { glyph: '◷', tone: 'warning', label: 'Waiting' },
  cancelled: { glyph: '⊘', tone: 'neutral', label: 'Cancelled' },
  skipped: { glyph: '⊖', tone: 'neutral', label: 'Skipped' }
}

export const issueLook = (row: IssueRow): Look => ISSUE[row.state]
export const pullLook = (row: PullRow): Look => PULL[row.state]
export const runLook = (row: RunRow): Look => RUN[row.state]

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
  ambiguous_workspace: { title: 'Several workspaces match', hint: 'Open a terminal in the workspace so the panel can tell which one it is.', tone: 'warning' },
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
  gh_failed: { title: 'gh failed', hint: 'Press Retry. The message below is what gh said.', tone: 'danger' }
}

export const problemOf = (code: ErrorCode): Problem => PROBLEMS[code] ?? PROBLEMS.gh_failed
