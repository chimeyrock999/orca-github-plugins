// The open issue and the new issue form, in atoms, and the actions that change them. Every write
// asks GitHub for the issue again afterwards, so the panel shows what GitHub has; comment edits,
// deletes and reactions change the timeline in place, so pages loaded with Load more stay.
import { atom, plugin, read, set, update } from 'orca'
import type { Answer, CloseReason, IssueDetail, PanelError, Reaction, ReactionGroup, TimelineComment, TimelineItem } from './protocol'
import { back, lists, load, loadChoices, repo, requestFailed, tab } from './store'

export type Picking = { kind: 'labels' | 'assignees'; selected: string[]; query: string; login: string }

export type IssueState = {
  number: number
  /** null while the issue loads. */
  answer: Answer<{ issue: IssueDetail }> | null
  /** The write or load running now (`comment`, `close`, `more`, `delete`, ...); one at a time. */
  busy: string | null
  /** Why the last write failed; what was typed is kept. */
  error: PanelError | null
  draft: string
  closing: { reason: CloseReason; duplicateOf: string } | null
  /** REST id of the comment asking to be deleted. */
  deleting: number | null
  editingComment: { id: number; body: string } | null
  editing: { title: string; body: string } | null
  picking: Picking | null
  /** Node id of the issue or comment whose reaction strip is open. */
  reacting: string | null
}

export type NewIssue = {
  title: string
  body: string
  labels: string[]
  assignees: string[]
  picking: Picking | null
  busy: boolean
  error: PanelError | null
}

function fresh(number: number): IssueState {
  return { number, answer: null, busy: null, error: null, draft: '', closing: null, deleting: null, editingComment: null, editing: null, picking: null, reacting: null }
}
const blankIssue = (): NewIssue => ({ title: '', body: '', labels: [], assignees: [], picking: null, busy: false, error: null })

export const issue = atom<IssueState>(fresh(0))
/** The issue open on screen, kept per workspace so the panel shows it again when it opens. */
export const lastIssue = atom<{ repo: string; path: string; number: number } | null>('openIssue', null, { persist: 'workspace' })
export const newIssue = atom<NewIssue>(blankIssue())

// Opening another issue, the form or the list makes answers for the one before stale.
let views = 0

/** Where an answer belongs: what is open, in which workspace. A repo or folder change makes an
 *  answer stale as surely as opening something else does. */
function here(): string {
  const r = read(repo)
  return `${views}\n${r?.ok ? `${r.nameWithOwner}\n${r.path}` : ''}`
}

/** Writes wait longer than reads: gh issue create makes several API calls. The worker gives gh 60 s. */
const WRITE = { timeoutMs: 90_000 }

/** A write with no answer may still have landed on GitHub. */
function unsure(error: PanelError): PanelError {
  if (error.code !== 'timeout' && error.code !== 'host_failed') return error
  return { code: 'unsure', message: error.message }
}
// A newer load of the same issue makes an older one stale.
let loads = 0
// A write changed an issue, so the list is asked for again on the way back.
let listStale = false

/** The issue on screen, once it has loaded. */
export function shown(): IssueDetail | null {
  const a = read(issue).answer
  return a?.ok ? a.issue : null
}

export async function loadIssue(): Promise<void> {
  const mine = ++loads
  const view = here()
  const number = read(issue).number
  const answer = await plugin.request('issue.get', { number }).catch(requestFailed)
  if (mine === loads && view === here()) update(issue, (s) => ({ ...s, answer }))
}

/** Opens an issue by number, from the list, a mention or a new issue. */
export function openIssue(number: number): Promise<void> {
  const r = read(repo)
  set(lastIssue, r?.ok ? { repo: r.nameWithOwner, path: r.path, number } : null)
  views++
  update(lists.issues, (s) => ({ ...s, open: String(number) }))
  set(issue, fresh(number))
  return loadIssue()
}

/** Back to the list, asking for it again when a write changed an issue. */
export function backToIssues(): Promise<void> | void {
  views++
  set(lastIssue, null)
  back('issues')
  if (!listStale) return
  listStale = false
  update(lists.issues, (s) => ({ ...s, counts: null }))
  return load('issues')
}

/** The timeline with a loaded page added after the head; once the head reaches the tail they join. */
export function mergeTimeline(head: TimelineItem[], tail: TimelineItem[], page: TimelineItem[], next: string | null) {
  const tailIds = new Set(tail.map((i) => i.id))
  const meet = page.findIndex((i) => tailIds.has(i.id))
  if (meet >= 0) return { head: [...head, ...page.slice(0, meet), ...tail], tail: [], next: null }
  if (next === null) return { head: [...head, ...page, ...tail.filter((i) => !page.some((p) => p.id === i.id))], tail: [], next: null }
  return { head: [...head, ...page], tail, next }
}

/** How many timeline items sit between the head and the tail. */
export function hiddenCount(detail: IssueDetail): number {
  return detail.next === null ? 0 : Math.max(0, detail.total - detail.head.length - detail.tail.length)
}

function changeShown(change: (detail: IssueDetail) => IssueDetail): void {
  update(issue, (s) => (s.answer?.ok ? { ...s, answer: { ...s.answer, issue: change(s.answer.issue) } } : s))
}

export async function loadMore(): Promise<void> {
  const s = read(issue)
  const detail = shown()
  if (s.busy || !detail?.next) return
  const view = here()
  update(issue, (x) => ({ ...x, busy: 'more', error: null }))
  const answer = await plugin.request('issue.timeline', { number: s.number, after: detail.next }).catch(requestFailed)
  if (view !== here()) return
  update(issue, (x) => ({ ...x, busy: null, error: answer.ok ? null : answer.error }))
  // A reload while the page was on its way starts the timeline over; the page then fits nowhere.
  if (answer.ok && shown()?.next === detail.next) changeShown((d) => ({ ...d, ...mergeTimeline(d.head, d.tail, answer.items, answer.next) }))
}

/** Runs one write; on success `done` tidies the state and the issue is asked for again. */
async function write(name: string, request: () => Promise<Answer<object>>, done: (s: IssueState) => IssueState, reload = true): Promise<boolean> {
  if (read(issue).busy) return false
  const view = here()
  update(issue, (s) => ({ ...s, busy: name, error: null }))
  const answer = await request().catch(requestFailed)
  if (answer.ok) listStale = true
  if (view !== here()) return false
  if (!answer.ok) {
    const error = unsure(answer.error)
    update(issue, (s) => ({ ...s, busy: null, error }))
    // It may have gone through: show what GitHub has now, keeping what was typed.
    if (error.code === 'unsure') {
      listStale = true
      if (reload) await loadIssue()
    }
    return false
  }
  update(issue, (s) => done({ ...s, busy: null }))
  if (reload) await loadIssue()
  return true
}

export const setDraft = (draft: string) => update(issue, (s) => ({ ...s, draft }))
export const dismissError = () => update(issue, (s) => ({ ...s, error: null }))

export function sendComment(): Promise<boolean> | void {
  const { number, draft } = read(issue)
  if (!draft.trim()) return
  return write('comment', () => plugin.request('issue.comment', { number, body: draft }, WRITE), (s) => ({ ...s, draft: '' }))
}

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
  return write('close', () => plugin.request('issue.close', input, WRITE), (s) => ({ ...s, draft: '', closing: null }))
}

export function reopen(): Promise<boolean> {
  const { number, draft } = read(issue)
  const input = { number, ...(draft.trim() ? { comment: draft } : {}) }
  return write('reopen', () => plugin.request('issue.reopen', input, WRITE), (s) => ({ ...s, draft: '' }))
}

function changeComment(id: number, change: (c: TimelineComment) => TimelineComment | null): void {
  const each = (items: TimelineItem[]) =>
    items.flatMap((i) => (i.kind === 'comment' && i.databaseId === id ? (change(i) ?? []) : [i]))
  changeShown((d) => ({ ...d, head: each(d.head), tail: each(d.tail) }))
}

export const startEditComment = (c: TimelineComment) => update(issue, (s) => ({ ...s, editingComment: { id: c.databaseId, body: c.body } }))
export const setCommentDraft = (body: string) =>
  update(issue, (s) => (s.editingComment ? { ...s, editingComment: { ...s.editingComment, body } } : s))
export const cancelEditComment = () => update(issue, (s) => ({ ...s, editingComment: null }))

export async function saveComment(): Promise<void> {
  const editing = read(issue).editingComment
  if (!editing?.body.trim()) return
  const ok = await write('edit-comment', () => plugin.request('comment.edit', editing, WRITE), (s) => ({ ...s, editingComment: null }), false)
  if (ok) changeComment(editing.id, (c) => ({ ...c, body: editing.body, edited: true, truncated: false }))
}

export const askDelete = (id: number) => update(issue, (s) => ({ ...s, deleting: id }))
export const cancelDelete = () => update(issue, (s) => ({ ...s, deleting: null }))

export async function confirmDelete(): Promise<void> {
  const id = read(issue).deleting
  if (id === null) return
  const ok = await write('delete', () => plugin.request('comment.delete', { id }, WRITE), (s) => ({ ...s, deleting: null }), false)
  if (ok) {
    changeComment(id, () => null)
    changeShown((d) => ({ ...d, comments: Math.max(0, d.comments - 1), total: Math.max(0, d.total - 1) }))
  }
}

export function startEdit(): void {
  const d = shown()
  if (d) update(issue, (s) => ({ ...s, editing: { title: d.title, body: d.body } }))
}
export const setEditing = (change: Partial<{ title: string; body: string }>) =>
  update(issue, (s) => (s.editing ? { ...s, editing: { ...s.editing, ...change } } : s))
export const cancelEdit = () => update(issue, (s) => ({ ...s, editing: null }))

export function saveEdit(): Promise<boolean> | void {
  const { number, editing } = read(issue)
  const d = shown()
  if (!editing || !d || !editing.title.trim()) return
  // A cut body is not sent back unless it was changed: saving it would drop the rest.
  const input = {
    number,
    ...(editing.title !== d.title ? { title: editing.title } : {}),
    ...(editing.body !== d.body ? { body: editing.body } : {})
  }
  return write('edit', () => plugin.request('issue.edit', input, WRITE), (s) => ({ ...s, editing: null }))
}

// Pickers for labels and assignees, on the issue or on the new issue form.

function startPicking(kind: Picking['kind'], selected: string[]): Picking {
  void loadChoices(kind === 'labels' ? 'labels' : 'assignees')
  return { kind, selected: [...selected], query: '', login: '' }
}

export function openPicker(kind: Picking['kind']): void {
  const d = shown()
  if (d) update(issue, (s) => ({ ...s, picking: startPicking(kind, kind === 'labels' ? d.labels : d.assignees) }))
}
export function openNewPicker(kind: Picking['kind']): void {
  update(newIssue, (s) => ({ ...s, picking: startPicking(kind, kind === 'labels' ? s.labels : s.assignees) }))
}

/** Changes the picker of the issue (`issue`) or of the new issue form (`new`). */
export function changePicker(where: 'issue' | 'new', change: (p: Picking) => Picking | null): void {
  const apply = <S extends { picking: Picking | null }>(s: S): S => (s.picking ? { ...s, picking: change(s.picking) } : s)
  if (where === 'issue') update(issue, apply)
  else update(newIssue, apply)
}
export const togglePick = (where: 'issue' | 'new', name: string, on: boolean) =>
  changePicker(where, (p) => ({ ...p, selected: on ? [...p.selected.filter((x) => x !== name), name] : p.selected.filter((x) => x !== name) }))
export const addLogin = (where: 'issue' | 'new', login: string) => {
  const name = login.trim().replace(/^@(?!me$)/, '')
  if (name) changePicker(where, (p) => ({ ...p, selected: p.selected.includes(name) ? p.selected : [...p.selected, name], login: '' }))
}

export function applyPicker(): Promise<boolean> | void {
  const { number, picking } = read(issue)
  const d = shown()
  if (!picking || !d) return
  const before = picking.kind === 'labels' ? d.labels : d.assignees
  const add = picking.selected.filter((x) => !before.includes(x))
  const remove = before.filter((x) => !picking.selected.includes(x))
  if (add.length + remove.length === 0) return update(issue, (s) => ({ ...s, picking: null }))
  const input =
    picking.kind === 'labels' ? { number, addLabels: add, removeLabels: remove } : { number, addAssignees: add, removeAssignees: remove }
  return write(picking.kind, () => plugin.request('issue.edit', input, WRITE), (s) => ({ ...s, picking: null }))
}

export function applyNewPicker(): void {
  update(newIssue, (s) => (s.picking ? { ...s, [s.picking.kind]: [...s.picking.selected], picking: null } : s))
}

// Reactions change in place, before GitHub answers; a refusal puts them back.

export const toggleReactions = (subjectId: string) => update(issue, (s) => ({ ...s, reacting: s.reacting === subjectId ? null : subjectId }))

function flip(groups: ReactionGroup[], content: Reaction, on: boolean, viewer: string | null): ReactionGroup[] {
  const found = groups.find((g) => g.content === content)
  // Already as asked: a second press before the first answered changes nothing.
  if (!!found?.viewerHasReacted === on) return groups
  const me = viewer ?? '@me'
  if (on && !found) return [...groups, { content, count: 1, viewerHasReacted: true, users: [me] }]
  return groups
    .map((g) =>
      g.content !== content
        ? g
        : {
            ...g,
            viewerHasReacted: on,
            count: g.count + (on ? 1 : -1),
            users: on ? [me, ...g.users] : g.users.filter((u) => u !== me && u !== '@me')
          }
    )
    .filter((g) => g.count > 0)
}

/** The reactions of the issue or one of its comments, as the panel holds them now. */
function reactionsOf(subjectId: string): ReactionGroup[] {
  const d = shown()
  if (!d) return []
  if (d.id === subjectId) return d.reactions
  const c = [...d.head, ...d.tail].find((i) => i.kind === 'comment' && i.id === subjectId)
  return c?.kind === 'comment' ? c.reactions : []
}

function setReactions(subjectId: string, change: (groups: ReactionGroup[]) => ReactionGroup[]): void {
  const each = (items: TimelineItem[]) => items.map((i) => (i.kind === 'comment' && i.id === subjectId ? { ...i, reactions: change(i.reactions) } : i))
  changeShown((d) => (d.id === subjectId ? { ...d, reactions: change(d.reactions) } : { ...d, head: each(d.head), tail: each(d.tail) }))
}

export async function react(subjectId: string, content: Reaction): Promise<void> {
  const on = !reactionsOf(subjectId).find((g) => g.content === content)?.viewerHasReacted
  const view = here()
  const viewer = shown()?.viewer ?? null
  setReactions(subjectId, (g) => flip(g, content, on, viewer))
  update(issue, (s) => ({ ...s, reacting: null, error: null }))
  const answer = await plugin.request('reaction.set', { subjectId, content, on }, WRITE).catch(requestFailed)
  if (view !== here() || answer.ok) return
  setReactions(subjectId, (g) => flip(g, content, !on, viewer))
  update(issue, (s) => ({ ...s, error: answer.error }))
}

// The new issue form.

/** The workspace (repo and folder) the Issues tab last started in, for this panel run. */
const startedIn = atom<string | null>(null)

/** The first time the Issues tab shows for a workspace: the issue Orca links to the workspace (one
 *  made from an issue), else the issue a past run left open, else the list. Once per workspace, so
 *  Back and tab switches stay where the person went. */
export async function startIssues(): Promise<void> {
  const r = read(repo)
  if (!r?.ok || read(tab) !== 'issues') return
  const workspace = `${r.nameWithOwner}\n${r.path}`
  if (read(startedIn) === workspace) return
  set(startedIn, workspace)
  if (read(lists.issues).open) return
  const links = await plugin.request('repo.links').catch(() => null)
  // The person may have opened something, or moved to another workspace, meanwhile.
  if (read(startedIn) !== workspace || read(lists.issues).open || read(tab) !== 'issues') return
  if (links?.ok && links.issue) return openIssue(links.issue)
  const last = read(lastIssue)
  // Another clone of the repo is another workspace, with its own issue.
  if (last && last.repo === r.nameWithOwner && last.path === r.path) return openIssue(last.number)
}

export function startNewIssue(): void {
  views++
  set(lastIssue, null)
  set(newIssue, blankIssue())
  update(lists.issues, (s) => ({ ...s, open: 'new' }))
}
export const setNewIssue = (change: Partial<Pick<NewIssue, 'title' | 'body'>>) => update(newIssue, (s) => ({ ...s, ...change }))

export async function createIssue(): Promise<void> {
  const s = read(newIssue)
  if (s.busy || !s.title.trim()) return
  const view = here()
  update(newIssue, (x) => ({ ...x, busy: true, error: null }))
  const answer = await plugin
    .request('issue.create', { title: s.title, body: s.body, labels: s.labels, assignees: s.assignees }, WRITE)
    .catch(requestFailed)
  if (answer.ok) listStale = true
  if (view !== here()) return set(newIssue, blankIssue())
  if (!answer.ok) {
    const error = unsure(answer.error)
    if (error.code === 'unsure') listStale = true
    return update(newIssue, (x) => ({ ...x, busy: false, error }))
  }
  set(newIssue, blankIssue())
  await openIssue(answer.number)
}
