// What changed in the focused workspace while the person was away: asked of the worker each time
// the workspace's repo answer comes (the worker says nothing unless they come back from an
// absence), dismissed for good, and each line opens the item or run it names.
import { atom, plugin, read, set, update } from 'orca'
import { issues } from '../issues/issue-store'
import { pulls } from '../pulls/pull-store'
import { openRun, tabShown } from '../runs/run-store'
import { repo, selectTab } from '../store'
import type { Since, SinceItem } from '../../shared/protocol'

/** Lines shown before "and N more". */
export const SINCE_LINES = 5

/** What the block shows, for the workspace it was asked in (`where`), or null: not away, nothing
 *  changed, dismissed, or the worker could not tell. `all`: "and N more" was pressed. */
export type SinceState = { where: string; answer: Since & { since: number }; all: boolean } | null

export const since = atom<SinceState>(null)
// A newer ask (another workspace, Refresh) makes an older answer stale.
let asks = 0

/** Asks the worker what changed since the person left the focused workspace. A failure shows
 *  nothing: the block is a convenience, and the tabs say what is wrong with GitHub. */
export async function loadSince(): Promise<void> {
  const r = read(repo)
  const mine = ++asks
  if (!r?.ok) return set(since, null)
  if (read(since)?.where !== r.workspaceId) set(since, null)
  const answer = await plugin.request('since.get', { workspaceId: r.workspaceId }).catch(() => null)
  if (mine !== asks) return
  // With the budget low the items were not asked for: the block says so, runs or not.
  if (!answer?.ok || answer.since === null || !(answer.items.length || answer.runs.length || answer.skipped)) return set(since, null)
  set(since, { where: r.workspaceId, answer: { ...answer, since: answer.since }, all: false })
}

/** The block goes, and the worker forgets the absence. */
export function dismissSince(): Promise<unknown> {
  const shown = read(since)
  asks++
  set(since, null)
  return shown ? plugin.request('since.dismiss', { workspaceId: shown.where }).catch(() => null) : Promise.resolve()
}

export const showAllSince = () => update(since, (s) => s && { ...s, all: true })

/** Opens the item in its tab, with the linked list behind it for Back. */
export async function openSinceItem(item: SinceItem): Promise<void> {
  const t = item.kind === 'issues' ? issues : pulls
  await selectTab(item.kind)
  await tabShown()
  await t.open(item.number, item.repo)
  await t.start()
}

/** Opens the run on the Actions tab. */
export async function openSinceRun(id: number): Promise<void> {
  await selectTab('runs')
  await openRun(id)
}
