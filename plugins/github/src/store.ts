// The panel's state in atoms, and the actions that change it. Each tab keeps its own list: the
// search, the page (a stack of cursors, so Previous goes back without asking GitHub for one), the
// answer, and the row open in detail.
import { atom, plugin, read, set, update, type Atom } from 'orca'
import type { Answer, IssueRow, ItemPage, ItemSort, Page, PanelError, PullRow, RepoAnswer, RunRow } from './protocol'

export type Kind = 'issues' | 'pulls' | 'runs'
export const KINDS: Kind[] = ['issues', 'pulls', 'runs']

export type AnyRow = IssueRow | PullRow | RunRow
/** A page of any tab; issues and pull requests also count open and closed. */
export type ListPage = Page<AnyRow> & Partial<Pick<ItemPage<AnyRow>, 'open' | 'closed'>>

export type ListState = {
  state: 'open' | 'closed'
  query: string
  /** The cursor each page was asked with; the last one is the page on screen. */
  cursors: (string | null)[]
  /** null while the page loads. */
  answer: Answer<ListPage> | null
  /** Key of the row open in detail. */
  open: string | null
  /** Filter values by name (author, label; workflow, status, event, branch); empty means any. */
  filters: Record<string, string>
  sort: ItemSort
  /** Which strip under the counts is open. */
  tool: 'filter' | 'sort' | null
  /** Open and closed counts of the search; asked for again only when the list starts over. */
  counts: { open: number; closed: number } | null
  /** What the search and text filter boxes hold before Enter, by name (`query`, `author`, `branch`). */
  drafts: Record<string, string>
}

function fresh(): ListState {
  return { state: 'open', query: '', cursors: [null], answer: null, open: null, filters: {}, sort: 'created-desc', tool: null, counts: null, drafts: {} }
}

/** What the worker last answered for the focused repo; null until it answers. */
export const repo = atom<RepoAnswer | null>(null)
export const tab = atom<Kind>('tab', 'issues', { persist: 'plugin' })
export const lists: Record<Kind, Atom<ListState>> = { issues: atom(fresh()), pulls: atom(fresh()), runs: atom(fresh()) }
/** Choices for the label and workflow filters, asked for when a filter strip first opens. */
export const choices = atom<{ labels: string[] | null; workflows: { id: number; name: string }[] | null }>({
  labels: null,
  workflows: null
})
// A new repo makes choices still on their way stale.
let choicesFor = 0

function sameRepo(a: RepoAnswer | null, b: RepoAnswer): boolean {
  return !!a?.ok && b.ok && a.nameWithOwner === b.nameWithOwner && a.path === b.path
}

/** The row's key in its list: its number, or a run's id. */
export function rowKey(row: AnyRow): string {
  return String('id' in row ? row.id : row.number)
}

// A newer load of a list makes the older answer stale.
const loads: Record<Kind, number> = { issues: 0, pulls: 0, runs: 0 }
// Tabs whose first page was asked for since the repo was set.
const started = new Set<Kind>()

/** A rejected plugin.request as a failed answer: a timeout says so, anything else is Orca's. */
export function requestFailed(error: unknown): { ok: false; error: PanelError } {
  const e = error as { code?: unknown; message?: unknown }
  return { ok: false, error: { code: e?.code === 'timeout' ? 'timeout' : 'host_failed', message: String(e?.message ?? error) } }
}

function ask(kind: Kind, s: ListState): Promise<Answer<ListPage>> {
  const after = s.cursors[s.cursors.length - 1]
  const answer =
    kind === 'runs'
      ? plugin.request('runs.list', { query: s.query, after, filters: s.filters })
      : plugin.request(kind === 'issues' ? 'issues.list' : 'pulls.list', {
          state: s.state,
          query: s.query,
          after,
          filters: s.filters,
          sort: s.sort,
          withCounts: s.counts === null
        })
  return (answer as Promise<Answer<ListPage>>).catch(requestFailed)
}

/** Asks for the page the list's cursors point at, dropping it if a newer load started. */
export async function load(kind: Kind): Promise<void> {
  const mine = ++loads[kind]
  const list = lists[kind]
  update(list, (s) => ({ ...s, answer: null }))
  const answer = await ask(kind, read(list))
  if (mine !== loads[kind]) return
  update(list, (s) => {
    const counted = answer.ok && typeof answer.open === 'number' && typeof answer.closed === 'number'
    return { ...s, answer, counts: counted ? { open: answer.open!, closed: answer.closed! } : s.counts }
  })
}

function restart(kind: Kind, change: Partial<ListState>): Promise<void> {
  update(lists[kind], (s) => ({ ...s, ...change, cursors: [null], open: null, counts: null }))
  return load(kind)
}

export const search = (kind: Kind, query: string) => restart(kind, { query: query.trim(), drafts: { ...read(lists[kind]).drafts, query: query.trim() } })
export const setDraft = (kind: Kind, name: string, value: string) =>
  update(lists[kind], (s) => ({ ...s, drafts: { ...s.drafts, [name]: value } }))
export const setSort = (kind: Kind, sort: ItemSort) => restart(kind, { sort })
export function setFilter(kind: Kind, name: string, value: string): Promise<void> {
  const s = read(lists[kind])
  return restart(kind, { filters: { ...s.filters, [name]: value.trim() }, drafts: { ...s.drafts, [name]: value.trim() } })
}
export const clearFilters = (kind: Kind) => restart(kind, { filters: {}, drafts: { query: read(lists[kind]).query } })

/** How many filters hold a value. */
export const filterCount = (s: ListState) => Object.values(s.filters).filter(Boolean).length

/** Opens or closes a strip; the label or workflow choices load the first time a filter opens. */
export function toggleTool(kind: Kind, tool: 'filter' | 'sort'): Promise<void> | void {
  update(lists[kind], (s) => ({ ...s, tool: s.tool === tool ? null : tool }))
  if (tool !== 'filter' || read(lists[kind]).tool !== 'filter') return
  const mine = choicesFor
  const keep = (value: unknown): void => {
    if (mine === choicesFor) update(choices, (c) => ({ ...c, [kind === 'runs' ? 'workflows' : 'labels']: value }))
  }
  if (kind === 'runs') {
    if (read(choices).workflows !== null) return
    return plugin.request('workflows.list').then((a) => keep(a.ok ? a.workflows : []), () => keep([]))
  }
  if (read(choices).labels !== null) return
  return plugin.request('labels.list').then((a) => keep(a.ok ? a.names : []), () => keep([]))
}
export const showState = (kind: Kind, state: 'open' | 'closed') => restart(kind, { state })

export function next(kind: Kind): Promise<void> | void {
  const s = read(lists[kind])
  if (!s.answer?.ok || !s.answer.next) return
  const after = s.answer.next
  update(lists[kind], (l) => ({ ...l, cursors: [...l.cursors, after] }))
  return load(kind)
}

export function previous(kind: Kind): Promise<void> | void {
  if (read(lists[kind]).cursors.length < 2) return
  update(lists[kind], (l) => ({ ...l, cursors: l.cursors.slice(0, -1) }))
  return load(kind)
}

export const openRow = (kind: Kind, key: string) => update(lists[kind], (s) => ({ ...s, open: key }))
export const back = (kind: Kind) => update(lists[kind], (s) => ({ ...s, open: null }))

/** Loads a tab's first page the first time it is shown. */
export function ensure(kind: Kind): Promise<void> | void {
  if (started.has(kind)) return
  started.add(kind)
  return load(kind)
}

export function selectTab(kind: Kind): Promise<void> | void {
  set(tab, kind)
  return ensure(kind)
}

/** A new repo answer: lists of another repo, or of no repo, start over. */
export function setRepo(answer: RepoAnswer): Promise<void> | void {
  const same = sameRepo(read(repo), answer)
  set(repo, answer)
  if (same) return
  started.clear()
  choicesFor++
  set(choices, { labels: null, workflows: null })
  for (const kind of KINDS) {
    loads[kind]++
    set(lists[kind], fresh())
  }
  if (answer.ok) return ensure(read(tab))
}

/** Asks for the repo again (an error may be gone), then reloads the page on screen. */
export async function refresh(): Promise<void> {
  const answer = await plugin.request('repo.get').catch(requestFailed)
  const same = sameRepo(read(repo), answer)
  await setRepo(answer)
  if (!same) return
  // Counted again too, and label or workflow choices asked for again when a filter next opens.
  choicesFor++
  set(choices, { labels: null, workflows: null })
  update(lists[read(tab)], (s) => ({ ...s, counts: null }))
  await load(read(tab))
}

/** Where Open on GitHub goes: the open row, or the tab's page of the repo. */
export function githubUrl(): string | null {
  const r = read(repo)
  if (!r?.ok) return null
  const kind = read(tab)
  const s = read(lists[kind])
  if (s.open && s.answer?.ok) {
    const row = s.answer.rows.find((x) => rowKey(x) === s.open)
    if (row) return row.url
  }
  return `${r.url}/${kind === 'runs' ? 'actions' : kind}`
}
