// The Pull requests tab: the pull requests linked to the focused workspace (or its branch's), each a
// thread (src/panel/thread/thread-store.ts) with what only pull requests have, a review (approve,
// request changes or comment) and, on your own, draft or ready for review. Orca's Tasks page lists,
// searches and filters a repo's pull requests, and its own pull request views close, reopen and
// merge them.
import { atom, plugin, read, set, update } from 'orca'
import type { PullDetail, ReviewEvent } from '../../shared/protocol'
import { atRepo, makeThread, WRITE, type ThreadState } from '../thread/thread-store'

export type PullState = ThreadState<PullDetail> & {
  /** The review being written; its body is the comment box's text. */
  reviewing: ReviewEvent | null
  /** Convert to draft was pressed and waits to be confirmed. */
  toDraft: boolean
}

/** How long after an answer whose merge state GitHub had not worked out yet it is asked again. */
export const timing = { mergeRetryMs: 4_000 }
// The pull request asked again already, so an answer that is still not worked out stays as it is.
const retried = atom<number | null>(null)

export const pulls = makeThread<PullDetail, Pick<PullState, 'reviewing' | 'toDraft'>>(
  'pulls',
  {
    get: (number, at) => plugin.request('pull.get', { number, ...at }).then((a) => (a.ok ? { ok: true as const, detail: a.pull } : a)),
    timeline: (number, after, at) => plugin.request('pull.timeline', { number, after, ...at }),
    comment: (number, body, at) => plugin.request('pull.comment', { number, body, ...at }, WRITE),
    edit: (input) => plugin.request('pull.edit', input, WRITE)
  },
  () => ({ reviewing: null, toDraft: false }),
  // GitHub works the merge state out on the first ask, so the first answer often says unknown.
  (d, current) => {
    if (d.merge !== 'unknown' || (d.state !== 'open' && d.state !== 'draft') || read(retried) === d.number) return
    set(retried, d.number)
    setTimeout(() => (current() ? void pulls.load() : undefined), timing.mergeRetryMs)
  }
)

export const pull = pulls.state

/** The workspace's own pull request, whose checks Orca's Checks tab shows: the first linked one of
 *  this repo (the branch's, when Orca links none). */
export function workspacePull(): number | null {
  return pulls.linkedNow()?.refs?.find((r) => r.repo === null)?.number ?? null
}

/** Whether the viewer wrote the pull request: GitHub lets no one approve or request changes on
 *  their own. */
export function ownPull(d: PullDetail): boolean {
  return !!d.viewer && d.viewer === d.author
}

/** Whether a review of this kind can be sent with what is typed: only an approval may be empty. */
export function canReview(d: PullDetail, event: ReviewEvent, body: string): boolean {
  if (event !== 'comment' && ownPull(d)) return false
  return event === 'approve' || !!body.trim()
}

export const startReview = () => update(pull, (s) => ({ ...s, reviewing: 'comment' as ReviewEvent }))
export const setReview = (event: ReviewEvent) => update(pull, (s) => (s.reviewing ? { ...s, reviewing: event } : s))
export const cancelReview = () => update(pull, (s) => ({ ...s, reviewing: null }))

export function submitReview(): Promise<boolean> | void {
  const { number, draft, reviewing } = read(pull)
  const d = pulls.shown()
  if (!reviewing || !d || !canReview(d, reviewing, draft)) return
  const input = { number, event: reviewing, body: draft, ...atRepo(read(pull)) }
  return pulls.write('review', () => plugin.request('pull.review', input, WRITE), (s) => ({ ...s, draft: '', reviewing: null }))
}

/** Whether the viewer can mark it ready or back to draft: their own, while it is open. */
export function canToggleDraft(d: PullDetail): boolean {
  return ownPull(d) && (d.state === 'open' || d.state === 'draft')
}

export const startDraft = () => update(pull, (s) => ({ ...s, toDraft: true }))
export const cancelDraft = () => update(pull, (s) => ({ ...s, toDraft: false }))

/** Marks the draft ready for review (`ready`), or, once confirmed, converts it back to draft. */
export function setReady(ready: boolean): Promise<boolean> | void {
  const { number } = read(pull)
  const d = pulls.shown()
  if (!d || !canToggleDraft(d)) return
  const input = { number, ready, ...atRepo(read(pull)) }
  return pulls.write(ready ? 'ready' : 'draft', () => plugin.request('pull.ready', input, WRITE), (s) => ({ ...s, toDraft: false }))
}
