// The panel's state in atoms, and the actions that change it. Each tab keeps its own list: the
// search, the page (a stack of cursors, so Previous goes back without asking GitHub for one), the
// answer, and the row open in detail.
import { atom, plugin, read, set, update, type Atom } from 'orca'
import type { Answer, ErrorCode, IssueRow, ItemPage, ItemSort, Page, PanelError, PullRow, RepoAnswer, RunRow } from './protocol'

export type Kind = 'issues' | 'pulls' | 'runs'
export const KINDS: Kind[] = ['issues', 'pulls', 'runs']

export type AnyRow = IssueRow | PullRow | RunRow
/** A page of any tab; issues and pull requests also count open and closed. */
export type ListPage = Page<AnyRow> & Partial<Pick<ItemPage<AnyRow>, 'open' | 'closed'>> & { branch?: string | null }

export type ListState = {
  state: 'open' | 'closed' | 'all'
  query: string
  /** The cursor each page was asked with; the last one is the page on screen. */
  cursors: (string | null)[]
  /** null while the page loads. */
  answer: Answer<ListPage> | null
  /** Key of the row open in detail; on Issues, `new` is the new issue form. */
  open: string | null
  /** Filter values by name (author, assignee, label; workflow, status, event, branch); empty means any. */
  filters: Record<string, string>
  sort: ItemSort
  /** Which strip under the counts is open. */
  tool: 'filter' | 'sort' | null
  /** Open and closed counts of the search; asked for again only when the list starts over. */
  counts: { open: number; closed: number } | null
  /** What the search and text filter boxes hold before Enter, by name (`query`, `author`, `branch`). */
  drafts: Record<string, string>
  /** Runs: the focused workspace's branch only (where the tab starts), or every branch. */
  scope: 'branch' | 'all'
  /** Runs: the workspace branch the last page was narrowed to, so All branches can come back to it. */
  branch: string | null
}

function fresh(): ListState {
  return {
    state: 'open',
    query: '',
    cursors: [null],
    answer: null,
    open: null,
    filters: {},
    sort: 'created-desc',
    tool: null,
    counts: null,
    drafts: {},
    scope: 'branch',
    branch: null
  }
}

/** What the worker last answered for the focused repo; null until it answers. */
export const repo = atom<RepoAnswer | null>(null)
export const tab = atom<Kind>('tab', 'issues', { persist: 'plugin' })
export const lists: Record<Kind, Atom<ListState>> = { issues: atom(fresh()), pulls: atom(fresh()), runs: atom(fresh()) }
export type Choices = { labels: string[] | null; workflows: { id: number; name: string }[] | null; assignees: string[] | null }
const noChoices = (): Choices => ({ labels: null, workflows: null, assignees: null })
/** Labels, workflows and assignable logins of the repo, asked for the first time a filter or picker
 *  needs them. */
export const choices = atom<Choices>(noChoices())
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

// Orca's rejection codes the panel has its own words for; any other code is a request the plugin
// got wrong, which Orca's typings say to treat as action_failed.
const KEPT = new Set<ErrorCode>(['timeout', 'cancelled', 'rate_limited', 'too_large', 'unavailable', 'action_failed'])

/** A rejected plugin.request as a failed answer, keeping Orca's code; one with no code is Orca not
 *  answering. */
export function requestFailed(error: unknown): { ok: false; error: PanelError } {
  const e = error as { code?: unknown; message?: unknown; retryAfterMs?: unknown }
  const code: ErrorCode =
    typeof e?.code !== 'string' ? 'host_failed' : KEPT.has(e.code as ErrorCode) ? (e.code as ErrorCode) : 'action_failed'
  const failure: PanelError = { code, message: String(e?.message ?? error) }
  if (typeof e?.retryAfterMs === 'number') failure.retryAfterMs = e.retryAfterMs
  return { ok: false, error: failure }
}

// Failures that say nothing of whether gh ran: no answer in time, the panel stopped waiting while
// the worker went on, or the answer broke or was too big on its way back.
const UNSURE = new Set<ErrorCode>(['timeout', 'host_failed', 'cancelled', 'action_failed', 'too_large', 'unavailable'])

/** A write that failed this way may still have landed on GitHub. */
export function unsure(error: PanelError): PanelError {
  if (!UNSURE.has(error.code)) return error
  return { code: 'unsure', message: error.message }
}

function ask(kind: Kind, s: ListState): Promise<Answer<ListPage>> {
  const after = s.cursors[s.cursors.length - 1]
  const answer =
    kind === 'runs'
      ? plugin.request('runs.list', { query: s.query, after, filters: s.filters, scope: s.scope })
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
    const branch = answer.ok && answer.branch ? answer.branch : s.branch
    return { ...s, answer, branch, counts: counted ? { open: answer.open!, closed: answer.closed! } : s.counts }
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
/** Runs of the workspace's branch, or of every branch. */
export const setScope = (scope: ListState['scope']) => restart('runs', { scope })
export function setFilter(kind: Kind, name: string, value: string): Promise<void> {
  const s = read(lists[kind])
  return restart(kind, { filters: { ...s.filters, [name]: value.trim() }, drafts: { ...s.drafts, [name]: value.trim() } })
}
export const clearFilters = (kind: Kind) => restart(kind, { filters: {}, drafts: { query: read(lists[kind]).query } })

/** How many filters hold a value. */
export const filterCount = (s: ListState) => Object.values(s.filters).filter(Boolean).length

/** Asks for one kind of choice unless it is already there; a failure leaves none to pick. */
export function loadChoices(name: keyof Choices): Promise<void> | void {
  if (read(choices)[name] !== null) return
  const mine = choicesFor
  const keep = (value: Choices[typeof name]): void => {
    if (mine === choicesFor) update(choices, (c) => ({ ...c, [name]: value }))
  }
  const asked =
    name === 'workflows'
      ? plugin.request('workflows.list').then((a) => keep(a.ok ? a.workflows : []))
      : name === 'labels'
        ? plugin.request('labels.list').then((a) => keep(a.ok ? a.names : []))
        : plugin.request('assignees.list').then((a) => keep(a.ok ? a.logins : []))
  return asked.catch(() => keep([]))
}

/** Opens or closes a strip; the label or workflow choices load the first time a filter opens. */
export function toggleTool(kind: Kind, tool: 'filter' | 'sort'): Promise<void> | void {
  update(lists[kind], (s) => ({ ...s, tool: s.tool === tool ? null : tool }))
  if (tool !== 'filter' || read(lists[kind]).tool !== 'filter') return
  return loadChoices(kind === 'runs' ? 'workflows' : 'labels')
}
export const showState = (kind: Kind, state: ListState['state']) => restart(kind, { state })

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
  set(choices, noChoices())
  for (const kind of KINDS) {
    loads[kind]++
    set(lists[kind], fresh())
  }
  if (answer.ok) return ensure(read(tab))
}

/** Picks the folder among workspaces that share the focused branch and name. */
export async function pickRepo(path: string): Promise<void> {
  await setRepo(await plugin.request('repo.pick', { path }).catch(requestFailed))
}

/** Forgets that pick, so the choice shows again. */
export async function unpickRepo(): Promise<void> {
  await setRepo(await plugin.request('repo.unpick').catch(requestFailed))
}

/** Asks for the repo again (an error may be gone), then reloads the page on screen. */
export async function refresh(): Promise<void> {
  const answer = await plugin.request('repo.get').catch(requestFailed)
  const same = sameRepo(read(repo), answer)
  await setRepo(answer)
  if (!same) return
  // Counted again too, and label or workflow choices asked for again when a filter next opens.
  choicesFor++
  set(choices, noChoices())
  update(lists[read(tab)], (s) => ({ ...s, counts: null }))
  await load(read(tab))
}

/** Where Open on GitHub goes: the open row, or the tab's page of the repo. */
export function githubUrl(): string | null {
  const r = read(repo)
  if (!r?.ok) return null
  const kind = read(tab)
  const s = read(lists[kind])
  // An issue opens by number, so it need not be on the page.
  if (kind === 'issues' && s.open && /^\d+$/.test(s.open)) return `${r.url}/issues/${s.open}`
  if (s.open && s.answer?.ok) {
    const row = s.answer.rows.find((x) => rowKey(x) === s.open)
    if (row) return row.url
  }
  return `${r.url}/${kind === 'runs' ? 'actions' : kind}`
}
