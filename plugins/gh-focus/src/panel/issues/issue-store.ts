// The open issue: a thread (src/panel/thread/thread-store.ts) with what only issues have, closing with a reason.
// New issues are made on Orca's Tasks page.
import { plugin, read, update } from 'orca'
import type { CloseReason, IssueDetail } from '../../shared/protocol'
import { atRepo, makeThread, WRITE, type ThreadState } from '../thread/thread-store'

export type IssueState = ThreadState<IssueDetail> & { closing: { reason: CloseReason; duplicateOf: string } | null }

export const issues = makeThread<IssueDetail, Pick<IssueState, 'closing'>>(
  'issues',
  {
    get: (number, at) => plugin.request('issue.get', { number, ...at }).then((a) => (a.ok ? { ok: true as const, detail: a.issue } : a)),
    timeline: (number, after, at) => plugin.request('issue.timeline', { number, after, ...at }),
    comment: (number, body, at) => plugin.request('issue.comment', { number, body, ...at }, WRITE),
    edit: (input) => plugin.request('issue.edit', input, WRITE)
  },
  () => ({ closing: null })
)

export const issue = issues.state

export const {
  shown,
  load: loadIssue,
  open: openIssue,
  backToList: backToIssues,
  loadMore,
  setDraft,
  dismissError,
  sendComment,
  start: startIssues,
  react
} = issues
export { hiddenCount, mergeTimeline } from '../thread/thread-store'

export const startClose = () => update(issue, (s) => ({ ...s, closing: { reason: 'completed' as CloseReason, duplicateOf: '' } }))
export const cancelClose = () => update(issue, (s) => ({ ...s, closing: null }))
export const setClosing = (change: Partial<{ reason: CloseReason; duplicateOf: string }>) =>
  update(issue, (s) => (s.closing ? { ...s, closing: { ...s.closing, ...change } } : s))

/** The issue number a duplicate repeats, or null when what was typed is none. */
export function duplicateNumber(text: string): number | null {
  const n = Number(text.trim().replace(/^#/, ''))
  return Number.isInteger(n) && n > 0 ? n : null
}

export function confirmClose(): Promise<boolean> | void {
  const { number, draft, closing } = read(issue)
  if (!closing) return
  const duplicateOf = closing.reason === 'duplicate' ? duplicateNumber(closing.duplicateOf) : null
  if (closing.reason === 'duplicate' && duplicateOf === null) return
  const input = { number, ...atRepo(read(issue)), reason: closing.reason, ...(duplicateOf ? { duplicateOf } : {}), ...(draft.trim() ? { comment: draft } : {}) }
  return issues.write('close', () => plugin.request('issue.close', input, WRITE), (s) => ({ ...s, draft: '', closing: null }))
}

export function reopen(): Promise<boolean> {
  const { number, draft } = read(issue)
  const input = { number, ...atRepo(read(issue)), ...(draft.trim() ? { comment: draft } : {}) }
  return issues.write('reopen', () => plugin.request('issue.reopen', input, WRITE), (s) => ({ ...s, draft: '' }))
}
