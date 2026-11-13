// An open issue or pull request (a thread), in atoms, and the actions both share: its timeline
// pages, the comment box, comment edits and deletes, title and body edits, label and assignee
// pickers, and reactions. Every write asks GitHub for the thread again afterwards, so the panel
// shows what GitHub has; comment edits, deletes and reactions change the timeline in place, so
// pages loaded with Load more stay.
import { atom, plugin, read, set, update, type Atom } from 'orca'
import type { Answer, IssueEdit, LinkedKind, LinkedRef, LinkedRow, PanelError, Reaction, ReactionGroup, ThreadDetail, TimelineItem } from './protocol'
import { back, itemKey, lists, loadChoices, repo, repoEpoch, requestFailed, tab, unsure } from './store'

export type ThreadKind = LinkedKind

/** What Orca links to the focused workspace, of one kind. `where` is the workspace (and repo
 *  change) it was found for; `refs` null while Orca is asked; `rows` GitHub's answer for them, asked
 *  only when there is a list to show. */
export type LinkedState = { where: string; refs: LinkedRef[] | null; rows: Answer<{ rows: LinkedRow[] }> | null }
export type Picking = { kind: 'labels' | 'assignees'; selected: string[]; query: string; login: string }

export type ThreadState<D extends ThreadDetail> = {
  number: number
  /** `owner/name` when the thread is of another repo than the focused one (Orca links it), else null. */
  repo: string | null
  /** null while the thread loads. */
  answer: Answer<{ detail: D }> | null
  /** The write or load running now (`comment`, `close`, `more`, `delete`, ...); one at a time. */
  busy: string | null
  /** Why the last write failed; what was typed is kept. */
  error: PanelError | null
  draft: string
  /** REST id of the comment asking to be deleted. */
  deleting: number | null
  editingComment: { id: number; body: string } | null
  editing: { title: string; body: string } | null
  picking: Picking | null
  /** Node id of the thread or comment whose reaction strip is open. */
  reacting: string | null
}

/** What a request about the thread adds so the worker asks the thread's repo: `{ repo }` when it is
 *  of another repo than the focused one, else nothing. */
export type At = { repo?: string }
export const atRepo = (s: { repo: string | null }): At => (s.repo ? { repo: s.repo } : {})

/** How a kind of thread is asked for and written. */
export type ThreadRequests<D extends ThreadDetail> = {
  get: (number: number, at: At) => Promise<Answer<{ detail: D }>>
  timeline: (number: number, after: string, at: At) => Promise<Answer<{ items: TimelineItem[]; next: string | null }>>
  comment: (number: number, body: string, at: At) => Promise<Answer<object>>
  edit: (input: IssueEdit & At) => Promise<Answer<object>>
}

/** Writes wait longer than reads: a write can make several API calls. The worker gives gh 60 s. */
export const WRITE = { timeoutMs: 90_000 }


/** The focused workspace: its repo and folder. */
export function workspace(): string {
  const r = read(repo)
  return r?.ok ? `${r.nameWithOwner}\n${r.path}` : ''
}

/** The workspace, and the repo change it was found after: a tab not on screen when the focus went
 *  elsewhere and back starts again when shown. */
export const focusKey = () => `${repoEpoch()}\n${workspace()}`

/** The linked item when it is the only one (of this repo or another): the only one a tab opens by
 *  itself. */
export function soleRef(refs: LinkedRef[] | null): LinkedRef | null {
  return refs?.length === 1 ? refs[0] : null
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
export function hiddenCount(detail: ThreadDetail): number {
  return detail.next === null ? 0 : Math.max(0, detail.total - detail.head.length - detail.tail.length)
}

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

// Pickers are pure changes of a Picking. `of` is the thread's repo when it is another one, whose
// labels and assignees are offered.
export function startPicking(kind: Picking['kind'], selected: string[], of: string | null = null): Picking {
  void loadChoices(kind === 'labels' ? 'labels' : 'assignees', of)
  return { kind, selected: [...selected], query: '', login: '' }
}
export const togglePicked = (p: Picking, name: string, on: boolean): Picking => ({
  ...p,
  selected: on ? [...p.selected.filter((x) => x !== name), name] : p.selected.filter((x) => x !== name)
})
export function withLogin(p: Picking, login: string): Picking {
  const name = login.trim().replace(/^@(?!me$)/, '')
  return name ? { ...p, selected: p.selected.includes(name) ? p.selected : [...p.selected, name], login: '' } : p
}

export type PickerOps = {
  change: (change: (p: Picking) => Picking | null) => void
  toggle: (name: string, on: boolean) => void
  addLogin: (login: string) => void
  apply: () => unknown
}
/** What a picker box does with its Picking, given how to change it and how to apply it. */
export function pickerOps(change: PickerOps['change'], apply: () => unknown): PickerOps {
  return { change, toggle: (name, on) => change((p) => togglePicked(p, name, on)), addLogin: (login) => change((p) => withLogin(p, login)), apply }
}

export type Thread<D extends ThreadDetail, X extends object = object> = ReturnType<typeof makeThread<D, X>>

/** One kind of thread, open in its own tab: `extra` adds the state only that kind has, and `loaded`
 *  hears each detail that lands, with a check that its view is still on screen. */
export function makeThread<D extends ThreadDetail, X extends object = object>(
  kind: ThreadKind,
  requests: ThreadRequests<D>,
  extra: () => X,
  loaded?: (detail: D, current: () => boolean) => void
) {
  type S = ThreadState<D> & X
  const fresh = (number: number, repo: string | null = null): S => ({
    number,
    repo,
    answer: null,
    busy: null,
    error: null,
    draft: '',
    deleting: null,
    editingComment: null,
    editing: null,
    picking: null,
    reacting: null,
    ...extra()
  })
  const state: Atom<S> = atom<S>(fresh(0))

  // Opening another thread or the list makes answers for the one before stale.
  let views = 0
  /** Where an answer belongs: what is open, in which workspace. A repo or folder change makes an
   *  answer stale as surely as opening something else does. */
  const here = () => `${views}\n${workspace()}`
  // A newer load of the same thread makes an older one stale.
  let loads = 0
  // A write changed a thread, so the linked list is asked for again on the way back. An atom, so a
  // new panel run starts clean.
  const listStale = atom(false)
  const linked = atom<LinkedState | null>(null)

  /** The thread on screen, once it has loaded. */
  function shown(): D | null {
    const a = read(state).answer
    return a?.ok ? a.detail : null
  }

  async function loadThread(): Promise<void> {
    const mine = ++loads
    const view = here()
    const answer = await requests.get(read(state).number, atRepo(read(state))).catch(requestFailed)
    if (mine !== loads || view !== here()) return
    update(state, (s) => ({ ...s, answer }))
    if (answer.ok) loaded?.(answer.detail, () => mine === loads && view === here())
  }

  /** Opens a thread by number (of `repo`, when another repo's), from the linked list, a mention, or
   *  as the workspace's only link. */
  function open(number: number, repo: string | null = null): Promise<void> {
    views++
    update(lists[kind], (s) => ({ ...s, open: itemKey(number, repo) }))
    set(state, fresh(number, repo))
    return loadThread()
  }

  /** Leaves the thread for the linked list or the empty state. */
  function leave(): void {
    views++
  }

  /** What Orca links to the workspace on screen, once found. */
  function linkedNow(): LinkedState | null {
    const l = read(linked)
    return l && l.where === focusKey() ? l : null
  }

  /** The workspace's only linked item of this repo, when there is just one. */
  const sole = () => soleRef(linkedNow()?.refs ?? null)

  /** Whether the thread open is this linked item. */
  function isShown(ref: Pick<LinkedRef, 'number' | 'repo'>): boolean {
    const s = read(state)
    return s.number === ref.number && (s.repo ?? '').toLowerCase() === (ref.repo ?? '').toLowerCase()
  }

  /** Asks GitHub for the linked items' title and state, for the list. */
  async function loadRows(): Promise<void> {
    const l = linkedNow()
    if (!l?.refs?.length) return
    const { where, refs } = l
    const mine = (x: LinkedState | null) => !!x && x.where === where && x.refs === refs
    update(linked, (x) => (mine(x) ? { ...x!, rows: null } : x))
    const rows = await plugin.request('items.get', { kind, items: refs }).catch(requestFailed)
    update(linked, (x) => (mine(x) ? { ...x!, rows } : x))
  }

  /** Back from a thread: to the workspace's only link when another one (a mention) is open, else to
   *  the linked list (asked for again when a write changed a thread, or never loaded) or the empty
   *  state. */
  function backToList(): Promise<void> | void {
    const one = sole()
    if (one && !isShown(one)) return open(one.number, one.repo)
    leave()
    back(kind)
    if (!read(listStale) && linkedNow()?.rows) return
    set(listStale, false)
    return loadRows()
  }

  const markStale = () => set(listStale, true)

  function changeShown(change: (detail: D) => D): void {
    update(state, (s) => (s.answer?.ok ? { ...s, answer: { ...s.answer, detail: change(s.answer.detail) } } : s))
  }

  async function loadMore(): Promise<void> {
    const s = read(state)
    const detail = shown()
    if (s.busy || !detail?.next) return
    const view = here()
    update(state, (x) => ({ ...x, busy: 'more', error: null }))
    const answer = await requests.timeline(s.number, detail.next, atRepo(s)).catch(requestFailed)
    if (view !== here()) return
    update(state, (x) => ({ ...x, busy: null, error: answer.ok ? null : answer.error }))
    // A reload while the page was on its way starts the timeline over; the page then fits nowhere.
    if (answer.ok && shown()?.next === detail.next) changeShown((d) => ({ ...d, ...mergeTimeline(d.head, d.tail, answer.items, answer.next) }))
  }

  /** Runs one write; on success `done` tidies the state and the thread is asked for again. */
  async function write(name: string, request: () => Promise<Answer<object>>, done: (s: S) => S, reload = true): Promise<boolean> {
    if (read(state).busy) return false
    const view = here()
    update(state, (s) => ({ ...s, busy: name, error: null }))
    const answer = await request().catch(requestFailed)
    if (answer.ok) markStale()
    if (view !== here()) return false
    if (!answer.ok) {
      const error = unsure(answer.error)
      update(state, (s) => ({ ...s, busy: null, error }))
      // It may have gone through: show what GitHub has now, keeping what was typed. In-place
      // writes reload too; that drops pages from Load more, which is fine for a rare failure.
      if (error.code === 'unsure') {
        markStale()
        await loadThread()
      }
      return false
    }
    update(state, (s) => done({ ...s, busy: null }))
    if (reload) await loadThread()
    return true
  }

  const setDraft = (draft: string) => update(state, (s) => ({ ...s, draft }))
  const dismissError = () => update(state, (s) => ({ ...s, error: null }))

  function sendComment(): Promise<boolean> | void {
    const { number, draft } = read(state)
    if (!draft.trim()) return
    return write('comment', () => requests.comment(number, draft, atRepo(read(state))), (s) => ({ ...s, draft: '' }))
  }

  function changeComment(id: number, change: (item: TimelineItem) => TimelineItem | null): void {
    const each = (items: TimelineItem[]) => items.flatMap((i) => (i.kind === 'comment' && i.databaseId === id ? (change(i) ?? []) : [i]))
    changeShown((d) => ({ ...d, head: each(d.head), tail: each(d.tail) }))
  }

  const startEditComment = (c: { databaseId: number; body: string }) => update(state, (s) => ({ ...s, editingComment: { id: c.databaseId, body: c.body } }))
  const setCommentDraft = (body: string) => update(state, (s) => (s.editingComment ? { ...s, editingComment: { ...s.editingComment, body } } : s))
  const cancelEditComment = () => update(state, (s) => ({ ...s, editingComment: null }))

  async function saveComment(): Promise<void> {
    const editing = read(state).editingComment
    if (!editing?.body.trim()) return
    const ok = await write('edit-comment', () => plugin.request('comment.edit', { ...editing, ...atRepo(read(state)) }, WRITE), (s) => ({ ...s, editingComment: null }), false)
    if (ok) changeComment(editing.id, (c) => ({ ...c, body: editing.body, edited: true, truncated: false }))
  }

  const askDelete = (id: number) => update(state, (s) => ({ ...s, deleting: id }))
  const cancelDelete = () => update(state, (s) => ({ ...s, deleting: null }))

  async function confirmDelete(): Promise<void> {
    const id = read(state).deleting
    if (id === null) return
    const ok = await write('delete', () => plugin.request('comment.delete', { id, ...atRepo(read(state)) }, WRITE), (s) => ({ ...s, deleting: null }), false)
    if (ok) {
      changeComment(id, () => null)
      changeShown((d) => ({ ...d, comments: Math.max(0, d.comments - 1), total: Math.max(0, d.total - 1) }))
    }
  }

  function startEdit(): void {
    const d = shown()
    if (d) update(state, (s) => ({ ...s, editing: { title: d.title, body: d.body } }))
  }
  const setEditing = (change: Partial<{ title: string; body: string }>) =>
    update(state, (s) => (s.editing ? { ...s, editing: { ...s.editing, ...change } } : s))
  const cancelEdit = () => update(state, (s) => ({ ...s, editing: null }))

  function saveEdit(): Promise<boolean> | void {
    const { number, editing } = read(state)
    const d = shown()
    if (!editing || !d || !editing.title.trim()) return
    // A cut body is not sent back unless it was changed: saving it would drop the rest.
    const input = {
      number,
      ...atRepo(read(state)),
      ...(editing.title !== d.title ? { title: editing.title } : {}),
      ...(editing.body !== d.body ? { body: editing.body } : {})
    }
    return write('edit', () => requests.edit(input), (s) => ({ ...s, editing: null }))
  }

  function openPicker(which: Picking['kind']): void {
    const d = shown()
    if (d) update(state, (s) => ({ ...s, picking: startPicking(which, which === 'labels' ? d.labels : d.assignees, s.repo) }))
  }
  const changePicker = (change: (p: Picking) => Picking | null) => update(state, (s) => (s.picking ? { ...s, picking: change(s.picking) } : s))

  function applyPicker(): Promise<boolean> | void {
    const { number, picking } = read(state)
    const d = shown()
    if (!picking || !d) return
    const before = picking.kind === 'labels' ? d.labels : d.assignees
    const add = picking.selected.filter((x) => !before.includes(x))
    const remove = before.filter((x) => !picking.selected.includes(x))
    if (add.length + remove.length === 0) return update(state, (s) => ({ ...s, picking: null }))
    const at = atRepo(read(state))
    const input =
      picking.kind === 'labels' ? { number, ...at, addLabels: add, removeLabels: remove } : { number, ...at, addAssignees: add, removeAssignees: remove }
    return write(picking.kind, () => requests.edit(input), (s) => ({ ...s, picking: null }))
  }

  // Reactions change in place, before GitHub answers; a refusal puts them back.

  const toggleReactions = (subjectId: string) => update(state, (s) => ({ ...s, reacting: s.reacting === subjectId ? null : subjectId }))

  const reactable = (i: TimelineItem): i is Extract<TimelineItem, { reactions: ReactionGroup[] }> => 'reactions' in i

  /** The reactions of the thread or one of its posts, as the panel holds them now. */
  function reactionsOf(subjectId: string): ReactionGroup[] {
    const d = shown()
    if (!d) return []
    if (d.id === subjectId) return d.reactions
    const post = [...d.head, ...d.tail].find((i) => reactable(i) && i.id === subjectId)
    return post && reactable(post) ? post.reactions : []
  }

  function setReactions(subjectId: string, change: (groups: ReactionGroup[]) => ReactionGroup[]): void {
    const each = (items: TimelineItem[]) => items.map((i) => (reactable(i) && i.id === subjectId ? { ...i, reactions: change(i.reactions) } : i))
    changeShown((d) => (d.id === subjectId ? { ...d, reactions: change(d.reactions) } : { ...d, head: each(d.head), tail: each(d.tail) }))
  }

  async function react(subjectId: string, content: Reaction): Promise<void> {
    const on = !reactionsOf(subjectId).find((g) => g.content === content)?.viewerHasReacted
    const view = here()
    const viewer = shown()?.viewer ?? null
    setReactions(subjectId, (g) => flip(g, content, on, viewer))
    update(state, (s) => ({ ...s, reacting: null, error: null }))
    const answer = await plugin.request('reaction.set', { subjectId, content, on }, WRITE).catch(requestFailed)
    if (view !== here() || answer.ok) return
    const error = unsure(answer.error)
    update(state, (s) => ({ ...s, error }))
    // A reaction with no answer may have landed: show GitHub's count rather than guess.
    if (error.code === 'unsure') return loadThread()
    setReactions(subjectId, (g) => flip(g, content, !on, viewer))
  }

  /** When the tab shows for a workspace it has not asked Orca about yet, or on Refresh (`again`):
   *  what Orca links to it. The only linked item of this repo opens by itself; several, or one of
   *  another repo, make a list, never opened by themselves; none leaves the empty state. Refresh
   *  keeps what is on screen until the new answer. */
  async function start(again = false): Promise<void> {
    if (!read(repo)?.ok) return
    // Refresh on another tab: this one asks Orca again when it next shows.
    if (read(tab) !== kind) return again ? set(linked, null) : undefined
    const where = focusKey()
    if (!again && read(linked)?.where === where) return
    if (!again || read(linked)?.where !== where) set(linked, { where, refs: null, rows: null })
    const links = await plugin.request('repo.links', kind === 'pulls' ? { branch: true } : {}).catch(() => null)
    // The person may have moved to another workspace meanwhile.
    if (focusKey() !== where) return
    const refs = links?.ok ? links[kind] : []
    set(linked, { where, refs, rows: null })
    const one = soleRef(refs)
    if (read(lists[kind]).open || read(tab) !== kind) return
    if (one) return open(one.number, one.repo)
    return loadRows()
  }

  /** Whether `here` still names the view a write began in. */
  const stillHere = (view: string) => view === here()

  return {
    kind,
    state,
    shown,
    here,
    stillHere,
    load: loadThread,
    open,
    leave,
    backToList,
    linkedNow,
    sole,
    isShown,
    loadRows,
    markStale,
    loadMore,
    write,
    setDraft,
    dismissError,
    sendComment,
    startEditComment,
    setCommentDraft,
    cancelEditComment,
    saveComment,
    askDelete,
    cancelDelete,
    confirmDelete,
    startEdit,
    setEditing,
    cancelEdit,
    saveEdit,
    openPicker,
    applyPicker,
    picker: pickerOps(changePicker, applyPicker),
    toggleReactions,
    react,
    start
  }
}

/** Any thread, for the views both kinds share. */
export type AnyThread = Thread<any, any>
