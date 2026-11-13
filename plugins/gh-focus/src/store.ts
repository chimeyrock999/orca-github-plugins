// The panel's state in atoms, and the actions that change it. Each tab keeps the row open in detail;
// the Actions tab also keeps its list: the search, the page (a stack of cursors, so Previous goes back
// without asking GitHub for one) and the answer. The Issues and Pull requests tabs list only what Orca
// links to the workspace (src/thread-store.ts).
import { atom, plugin, read, set, update, type Atom } from 'orca'
import { hostFailure } from './host-error'
import type { Answer, ErrorCode, PanelError, RepoAnswer, RunPage } from './protocol'

export type Kind = 'issues' | 'pulls' | 'runs'
export const KINDS: Kind[] = ['issues', 'pulls', 'runs']

export type ListState = {
  query: string
  /** The cursor each page was asked with; the last one is the page on screen. */
  cursors: (string | null)[]
  /** null while the page loads. */
  answer: Answer<RunPage> | null
  /** Key of the row open in detail: an issue or pull request number, a run id, or the Run workflow form. */
  open: string | null
  /** Run filter values by name (workflow, status, event, branch); empty means any. */
  filters: Record<string, string>
  /** Whether the filter strip is open. */
  tool: 'filter' | null
  /** What the search and text filter boxes hold before Enter, by name (`query`, `branch`). */
  drafts: Record<string, string>
  /** Runs: the focused workspace's branch only (where the tab starts), or every branch. */
  scope: 'branch' | 'all'
  /** Runs: the workspace branch the last page was narrowed to, so All branches can come back to it. */
  branch: string | null
}

function fresh(): ListState {
  return {
    query: '',
    cursors: [null],
    answer: null,
    open: null,
    filters: {},
    tool: null,
    drafts: {},
    scope: 'branch',
    branch: null
  }
}

/** What the worker last answered for the focused repo; null until it answers. */
export const repo = atom<RepoAnswer | null>(null)
export const tab = atom<Kind>('tab', 'issues', { persist: 'plugin' })
export const lists: Record<Kind, Atom<ListState>> = { issues: atom(fresh()), pulls: atom(fresh()), runs: atom(fresh()) }
/** Labels and assignees by repo (`choiceKey`): the focused one's, and those of each other repo a
 *  linked item asked for, so a picker never shows another repo's. Workflows are the focused repo's. */
export type Choices = { labels: Record<string, string[]>; workflows: { id: number; name: string }[] | null; assignees: Record<string, string[]> }
const noChoices = (): Choices => ({ labels: {}, workflows: null, assignees: {} })
/** Where a repo's labels and assignees are kept: `''` for the focused repo, else its `owner/name`. */
export const choiceKey = (of: string | null): string => of?.toLowerCase() ?? ''
/** The labels or assignees of `of` (null: the focused repo), or null until they are asked for. */
export function choicesOf(name: 'labels' | 'assignees', of: string | null): string[] | null {
  return read(choices)[name][choiceKey(of)] ?? null
}
/** Labels, workflows and assignable logins of the repo, asked for the first time a filter or picker
 *  needs them. */
export const choices = atom<Choices>(noChoices())
// A new repo makes choices still on their way stale.
let choicesFor = 0

function sameRepo(a: RepoAnswer | null, b: RepoAnswer): boolean {
  return !!a?.ok && b.ok && a.nameWithOwner === b.nameWithOwner && a.path === b.path
}

// A newer load of the runs list makes the older answer stale.
let loads = 0
// Tabs whose first page was asked for since the repo was set.
const started = new Set<Kind>()
// Goes up each time the repo answer changes, so what started for a workspace starts again.
let repoChanges = 0
/** How many times the repo answer has changed in this panel run. */
export const repoEpoch = () => repoChanges

/** A rejected plugin.request as a failed answer, keeping what Orca's code means. */
export function requestFailed(error: unknown): { ok: false; error: PanelError } {
  return { ok: false, error: hostFailure(error) }
}

// Failures that say nothing of whether gh ran: no answer in time, the panel stopped waiting while
// the worker went on, or the answer broke or was too big on its way back.
const UNSURE = new Set<ErrorCode>(['timeout', 'host_failed', 'cancelled', 'action_failed', 'too_large', 'unavailable'])

/** A write that failed this way may still have landed on GitHub. */
export function unsure(error: PanelError): PanelError {
  if (!UNSURE.has(error.code)) return error
  return { code: 'unsure', message: error.message }
}

function ask(s: ListState): Promise<Answer<RunPage>> {
  const after = s.cursors[s.cursors.length - 1]
  return plugin.request('runs.list', { query: s.query, after, filters: s.filters, scope: s.scope }).catch(requestFailed)
}

/** Asks for the runs page the list's cursors point at, dropping it if a newer load started. Only the
 *  Actions tab has a list: the others show what Orca links to the workspace. */
export async function load(kind: Kind): Promise<void> {
  if (kind !== 'runs') return
  const mine = ++loads
  const list = lists.runs
  update(list, (s) => ({ ...s, answer: null }))
  const answer = await ask(read(list))
  if (mine !== loads) return
  update(list, (s) => ({ ...s, answer, branch: answer.ok && answer.branch ? answer.branch : s.branch }))
}

function restart(kind: Kind, change: Partial<ListState>): Promise<void> {
  update(lists[kind], (s) => ({ ...s, ...change, cursors: [null], open: null }))
  return load(kind)
}

export const search = (kind: Kind, query: string) => restart(kind, { query: query.trim(), drafts: { ...read(lists[kind]).drafts, query: query.trim() } })
export const setDraft = (kind: Kind, name: string, value: string) =>
  update(lists[kind], (s) => ({ ...s, drafts: { ...s.drafts, [name]: value } }))
/** Runs of the workspace's branch, or of every branch. */
export const setScope = (scope: ListState['scope']) => restart('runs', { scope })
export function setFilter(kind: Kind, name: string, value: string): Promise<void> {
  const s = read(lists[kind])
  return restart(kind, { filters: { ...s.filters, [name]: value.trim() }, drafts: { ...s.drafts, [name]: value.trim() } })
}
export const clearFilters = (kind: Kind) => restart(kind, { filters: {}, drafts: { query: read(lists[kind]).query } })

/** How many filters hold a value. */
export const filterCount = (s: ListState) => Object.values(s.filters).filter(Boolean).length

export type ChoiceName = keyof Choices

/** Asks for one kind of choice unless it is already there; a failure leaves none to pick. Labels and
 *  assignees are of `of` (null: the focused repo). */
export function loadChoices(name: ChoiceName, of: string | null = null): Promise<void> | void {
  const mine = choicesFor
  if (name === 'workflows') {
    if (read(choices).workflows !== null) return
    const keep = (workflows: Choices['workflows']) => (mine === choicesFor ? update(choices, (c) => ({ ...c, workflows })) : undefined)
    return plugin.request('workflows.list').then((a) => keep(a.ok ? a.workflows : []), () => keep([]))
  }
  if (choicesOf(name, of) !== null) return
  const key = choiceKey(of)
  const keep = (values: string[]) => (mine === choicesFor ? update(choices, (c) => ({ ...c, [name]: { ...c[name], [key]: values } })) : undefined)
  const at = of ? { repo: of } : {}
  const asked =
    name === 'labels'
      ? plugin.request('labels.list', at).then((a) => keep(a.ok ? a.names : []))
      : plugin.request('assignees.list', at).then((a) => keep(a.ok ? a.logins : []))
  return asked.catch(() => keep([]))
}

/** Opens or closes the filter strip; the workflow choices load the first time it opens. */
export function toggleTool(kind: Kind): Promise<void> | void {
  update(lists[kind], (s): ListState => ({ ...s, tool: s.tool ? null : 'filter' }))
  if (read(lists[kind]).tool) return loadChoices('workflows')
}

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

/** The key of an issue or pull request open in its tab: its number, or `owner/name#N` for another repo's. */
export const itemKey = (number: number, repo: string | null = null): string => (repo ? `${repo}#${number}` : String(number))

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
  repoChanges++
  started.clear()
  choicesFor++
  set(choices, noChoices())
  loads++
  for (const kind of KINDS) set(lists[kind], fresh())
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
  // Label, assignee or workflow choices are asked for again when a picker or filter next opens.
  choicesFor++
  set(choices, noChoices())
  await load(read(tab))
}

/** Where Open on GitHub goes: the open row, or the tab's page of the repo. */
export function githubUrl(): string | null {
  const r = read(repo)
  if (!r?.ok) return null
  const kind = read(tab)
  const s = read(lists[kind])
  // Issues and pull requests open by number (`owner/name#N` for another repo's), so they need not be
  // on the page.
  const item = kind !== 'runs' && s.open ? /^(?:([^#]+)#)?(\d+)$/.exec(s.open) : null
  if (item) {
    const base = item[1] ? `${new URL(r.url).origin}/${item[1]}` : r.url
    return `${base}/${kind === 'issues' ? 'issues' : 'pull'}/${item[2]}`
  }
  if (s.open && s.answer?.ok) {
    const row = s.answer.rows.find((x) => String(x.id) === s.open)
    if (row) return row.url
  }
  return `${r.url}/${kind === 'runs' ? 'actions' : kind}`
}
