// The Pull requests tab: the focused workspace's pull request, as a thread (src/panel/thread/thread-store.ts)
// with what only pull requests have, a review (approve, request changes or comment). There is no
// list: Orca's Tasks page lists, searches and filters a repo's pull requests, and its own pull
// request views close, reopen and merge them.
import { atom, plugin, read, set, update } from 'orca'
import type { OrcaView, PanelError, PullDetail, ReviewEvent } from '../../shared/protocol'
import { lists, repo, repoEpoch, requestFailed, tab } from '../store'
import { makeThread, workspace, WRITE, type ThreadState } from '../thread/thread-store'

export type PullState = ThreadState<PullDetail> & {
  /** The review being written; its body is the comment box's text. */
  reviewing: ReviewEvent | null
}

/** How long after an answer whose merge state GitHub had not worked out yet it is asked again. */
export const timing = { mergeRetryMs: 4_000 }
// The pull request asked again already, so an answer that is still not worked out stays as it is.
const retried = atom<number | null>(null)

export const pulls = makeThread<PullDetail, Pick<PullState, 'reviewing'>>(
  'pulls',
  {
    get: (number) => plugin.request('pull.get', { number }).then((a) => (a.ok ? { ok: true as const, detail: a.pull } : a)),
    timeline: (number, after) => plugin.request('pull.timeline', { number, after }),
    comment: (number, body) => plugin.request('pull.comment', { number, body }, WRITE),
    edit: (input) => plugin.request('pull.edit', input, WRITE)
  },
  () => ({ reviewing: null }),
  // GitHub works the merge state out on the first ask, so the first answer often says unknown.
  (d, current) => {
    if (d.merge !== 'unknown' || (d.state !== 'open' && d.state !== 'draft') || read(retried) === d.number) return
    set(retried, d.number)
    setTimeout(() => (current() ? void pulls.load() : undefined), timing.mergeRetryMs)
  }
)

export const pull = pulls.state

/** The workspace's own pull request: null while it is being found; `number` null when it has none.
 *  `where` is the workspace it was found for. */
export const focus = atom<{ where: string; number: number | null } | null>(null)

/** The workspace, and the repo change it was found after. */
const focusKey = () => `${repoEpoch()}\n${workspace()}`

/** The focused pull request, once found for the workspace on screen. */
export function focused(): { number: number | null } | null {
  const f = read(focus)
  return f && f.where === focusKey() ? f : null
}

/** When the tab shows for a workspace it has not found a pull request for yet (or on Refresh): the
 *  one Orca links to it, else its branch's, opened unless another is open already. */
export async function findPull(again = false): Promise<void> {
  if (!read(repo)?.ok || read(tab) !== 'pulls') return
  const where = focusKey()
  if (!again && read(focus)?.where === where) return
  // Refresh keeps what it found until the new answer; a new workspace shows that it is looking.
  if (!again) set(focus, null)
  const links = await plugin.request('repo.links', { branch: true }).catch(() => null)
  if (focusKey() !== where) return
  const number = links?.ok ? links.pull : null
  set(focus, { where, number })
  if (number && !read(lists.pulls).open && read(tab) === 'pulls') await pulls.open(number)
}

/** Back from another pull request (opened from a mention) to the workspace's own, or to none. */
export function backToFocus(): Promise<void> | void {
  const number = focused()?.number
  if (number) return pulls.open(number)
  pulls.leave()
  update(lists.pulls, (s) => ({ ...s, open: null }))
}

/** Why the last hand-off to Orca did not happen; null when it did. */
export const handOffError = atom<PanelError | null>(null)

/** Hands off to Orca's Tasks page or Checks tab; when Orca will not (not the desktop app, say),
 *  the tab says why and Open on GitHub stays. */
export async function handOff(view: OrcaView): Promise<void> {
  set(handOffError, null)
  const answer = await plugin.request('orca.show', { view }).catch(requestFailed)
  if (!answer.ok) set(handOffError, answer.error)
}
export const dismissHandOff = () => set(handOffError, null)

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
  const input = { number, event: reviewing, body: draft }
  return pulls.write('review', () => plugin.request('pull.review', input, WRITE), (s) => ({ ...s, draft: '', reviewing: null }))
}
