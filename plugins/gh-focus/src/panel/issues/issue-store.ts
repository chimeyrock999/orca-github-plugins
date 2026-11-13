// The open issue and the new issue form. The issue is a thread (src/panel/thread/thread-store.ts) with what only
// issues have: closing with a reason, and the new issue form.
import { atom, plugin, read, set, update } from 'orca'
import type { CloseReason, IssueDetail, PanelError } from '../../shared/protocol'
import { lists, requestFailed, unsure } from '../store'
import { makeThread, pickerOps, startPicking, WRITE, type Picking, type ThreadState } from '../thread/thread-store'

export type IssueState = ThreadState<IssueDetail> & { closing: { reason: CloseReason; duplicateOf: string } | null }

export type NewIssue = {
  title: string
  body: string
  labels: string[]
  assignees: string[]
  picking: Picking | null
  busy: boolean
  error: PanelError | null
}

export const issues = makeThread<IssueDetail, Pick<IssueState, 'closing'>>(
  'issues',
  {
    get: (number) => plugin.request('issue.get', { number }).then((a) => (a.ok ? { ok: true as const, detail: a.issue } : a)),
    timeline: (number, after) => plugin.request('issue.timeline', { number, after }),
    comment: (number, body) => plugin.request('issue.comment', { number, body }, WRITE),
    edit: (input) => plugin.request('issue.edit', input, WRITE)
  },
  () => ({ closing: null })
)

export const issue = issues.state
const blankIssue = (): NewIssue => ({ title: '', body: '', labels: [], assignees: [], picking: null, busy: false, error: null })
export const newIssue = atom<NewIssue>(blankIssue())

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
  const input = { number, reason: closing.reason, ...(duplicateOf ? { duplicateOf } : {}), ...(draft.trim() ? { comment: draft } : {}) }
  return issues.write('close', () => plugin.request('issue.close', input, WRITE), (s) => ({ ...s, draft: '', closing: null }))
}

export function reopen(): Promise<boolean> {
  const { number, draft } = read(issue)
  const input = { number, ...(draft.trim() ? { comment: draft } : {}) }
  return issues.write('reopen', () => plugin.request('issue.reopen', input, WRITE), (s) => ({ ...s, draft: '' }))
}

// The new issue form.

export function openNewPicker(kind: Picking['kind']): void {
  update(newIssue, (s) => ({ ...s, picking: startPicking(kind, kind === 'labels' ? s.labels : s.assignees) }))
}
export const changeNewPicker = (change: (p: Picking) => Picking | null) => update(newIssue, (s) => (s.picking ? { ...s, picking: change(s.picking) } : s))

export function applyNewPicker(): void {
  update(newIssue, (s) => (s.picking ? { ...s, [s.picking.kind]: [...s.picking.selected], picking: null } : s))
}

export const newPicker = pickerOps(changeNewPicker, applyNewPicker)

export function startNewIssue(): void {
  issues.leave()
  set(newIssue, blankIssue())
  update(lists.issues, (s) => ({ ...s, open: 'new' }))
}
export const setNewIssue = (change: Partial<Pick<NewIssue, 'title' | 'body'>>) => update(newIssue, (s) => ({ ...s, ...change }))

export async function createIssue(): Promise<void> {
  const s = read(newIssue)
  if (s.busy || !s.title.trim()) return
  const view = issues.here()
  update(newIssue, (x) => ({ ...x, busy: true, error: null }))
  const answer = await plugin
    .request('issue.create', { title: s.title, body: s.body, labels: s.labels, assignees: s.assignees }, WRITE)
    .catch(requestFailed)
  if (answer.ok) issues.markStale()
  if (!issues.stillHere(view)) return set(newIssue, blankIssue())
  if (!answer.ok) {
    const error = unsure(answer.error)
    if (error.code === 'unsure') issues.markStale()
    return update(newIssue, (x) => ({ ...x, busy: false, error }))
  }
  set(newIssue, blankIssue())
  await openIssue(answer.number)
}
