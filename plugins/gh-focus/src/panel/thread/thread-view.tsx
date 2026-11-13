// What an issue and a pull request draw alike: a post (body or comment) with its reactions, the
// timeline with Load more, the metadata lines and their pickers, and the title and body editor.
import {
  Badge,
  Box,
  Button,
  Callout,
  Checkbox,
  IconButton,
  Input,
  Link,
  List,
  ListItem,
  Markdown,
  read,
  RelativeTime,
  Row,
  shell,
  Spinner,
  Stack,
  Text,
  Textarea,
  Toolbar,
  type OrcaNode
} from 'orca'
import { issues } from '../issues/issue-store'
import { count, EMOJI, pullLook, reactionTip, reviewLook, sourceLook, stateWords, type Look } from '../look'
import { Glyph } from '../parts'
import { findPull, focused, handOff, pulls } from '../pulls/pull-store'
import { REACTIONS, type ReactionGroup, type ThreadDetail, type TimelineComment, type TimelineItem, type TimelineMention, type TimelineReview } from '../../shared/protocol'
import { hasImage, linkRefs } from '../refs'
import { choices, repo, selectTab } from '../store'
import { hiddenCount, type AnyThread, type Picking, type PickerOps, type ThreadState } from './thread-store'

function repoUrl(): string {
  const r = read(repo)
  return r?.ok ? r.url : 'https://github.com'
}

function Reactions({ t, subject, groups }: { t: AnyThread; subject: string; groups: ReactionGroup[] }) {
  const s = read(t.state)
  const open = s.reacting === subject
  const viewer = s.answer?.ok ? s.answer.detail.viewer : null
  return (
    <Stack gap="xs">
      <Row gap="xs" wrap>
        {groups.map((g) => (
          <Button
            key={g.content}
            size="xs"
            variant={g.viewerHasReacted ? 'outline' : 'ghost'}
            tooltip={reactionTip(g, viewer)}
            onPress={() => t.react(subject, g.content)}
          >
            {`${EMOJI[g.content]} ${g.count}`}
          </Button>
        ))}
        <Button size="xs" variant={open ? 'solid' : 'outline'} tooltip="Add reaction" onPress={() => t.toggleReactions(subject)}>
          ☺ +
        </Button>
      </Row>
      {open && (
        <Toolbar label="Reactions" gap="xs">
          {REACTIONS.map((content) => (
            <Button key={content} size="xs" variant="ghost" tooltip={content.toLowerCase().replace('_', ' ')} onPress={() => t.react(subject, content)}>
              {EMOJI[content]}
            </Button>
          ))}
        </Toolbar>
      )}
    </Stack>
  )
}

function Cut({ url }: { url: string }) {
  return (
    <Text size="xs" muted>
      {'Cut short here. '}
      <Link onPress={() => shell.openExternal(url)}>Read it all on GitHub</Link>
    </Text>
  )
}

/** A body or comment in its box: who and when on top, the Markdown, then reactions. */
export function Post({ t, head, tools, body, url, cut, subject, reactions, empty = 'No description provided.', children }: {
  t: AnyThread
  head: OrcaNode
  tools?: OrcaNode
  body: string
  url: string
  cut: boolean
  subject: string
  reactions: ReactionGroup[]
  /** What an empty body says; null shows nothing. */
  empty?: string | null
  /** Drawn under the text, above the reactions. */
  children?: OrcaNode
}) {
  return (
    <Box border radius="md">
      <Box direction="row" justify="between" align="center" gap="xs" paddingX="sm" paddingY="xs" background="muted">
        <Text size="sm">{head}</Text>
        {tools}
      </Box>
      <Box padding="sm" gap="sm">
        {body.trim() ? (
          <Markdown content={linkRefs(body, repoUrl())} />
        ) : (
          empty !== null && (
            <Text size="sm" muted>
              {empty}
            </Text>
          )
        )}
        {cut && <Cut url={url} />}
        {hasImage(body) && (
          <Text size="xs" muted>
            Images show on GitHub only.
          </Text>
        )}
        {children}
        <Reactions t={t} subject={subject} groups={reactions} />
      </Box>
    </Box>
  )
}

/** Who and what, as a post's head says it: "kenji commented 2 days ago · edited". */
export function Byline({ who, words, at, after = '' }: { who: string | null; words: string; at: number; after?: string }) {
  return (
    <>
      <Text size="sm" weight="semibold">
        {who ?? 'ghost'}
      </Text>
      <Text size="sm" muted>
        {` ${words} `}
        <RelativeTime at={at} />
        {after}
      </Text>
    </>
  )
}

function CommentItem({ t, c, s }: { t: AnyThread; c: TimelineComment; s: ThreadState<ThreadDetail> }) {
  if (s.editingComment?.id === c.databaseId) {
    return (
      <Box border radius="md" padding="sm" gap="sm">
        <Textarea label={`Edit ${c.author ?? 'ghost'}'s comment`} rows={6} value={s.editingComment.body} onChange={t.setCommentDraft} onSubmit={t.saveComment} />
        <Row gap="xs">
          <Button size="sm" variant="solid" disabled={!s.editingComment.body.trim() || !!s.busy} onPress={t.saveComment}>
            Update comment
          </Button>
          <Button size="sm" variant="ghost" onPress={t.cancelEditComment}>
            Cancel
          </Button>
          {s.busy === 'edit-comment' && <Spinner label="Saving" labelHidden />}
        </Row>
      </Box>
    )
  }
  const tools = (c.canEdit || c.canDelete) && (
    <Toolbar label="Comment actions" gap="none">
      {/* A cut comment would lose its end if saved, so it is edited on GitHub. */}
      {c.canEdit && !c.truncated && <IconButton icon="edit" label="Edit comment" size="sm" variant="ghost" onPress={() => t.startEditComment(c)} />}
      {c.canDelete && <IconButton icon="delete" label="Delete comment" size="sm" variant="ghost" onPress={() => t.askDelete(c.databaseId)} />}
    </Toolbar>
  )
  const head = <Byline who={c.author} words="commented" at={c.createdAt} after={c.edited ? ' · edited' : ''} />
  return (
    <Stack gap="xs">
      <Post t={t} head={head} tools={tools} body={c.body} url={c.url} cut={c.truncated} subject={c.id} reactions={c.reactions} />
      {s.deleting === c.databaseId && (
        <Callout tone="danger" title="Delete this comment?">
          <Stack gap="sm">
            <Text size="sm">This cannot be undone.</Text>
            <Row gap="xs">
              <Button size="sm" variant="solid" tone="danger" disabled={!!s.busy} onPress={t.confirmDelete}>
                Delete
              </Button>
              <Button size="sm" variant="ghost" onPress={t.cancelDelete}>
                Cancel
              </Button>
              {s.busy === 'delete' && <Spinner label="Deleting" labelHidden />}
            </Row>
          </Stack>
        </Callout>
      )}
    </Stack>
  )
}

/** Opens an issue or pull request of this repo in its tab. */
function openHere(type: 'issue' | 'pull', number: number): Promise<void> {
  const t = type === 'issue' ? issues : pulls
  void selectTab(t.kind)
  // The Pull requests tab also learns the workspace's own, for Back.
  return t.open(number).then(() => (type === 'pull' ? findPull() : undefined))
}

function Mention({ item }: { item: TimelineMention }) {
  const r = read(repo)
  const own = r?.ok && item.source.repo.toLowerCase() === r.nameWithOwner.toLowerCase()
  // Issues and pull requests of this repo open here, in their own tab; other repos on GitHub.
  const go = () => (own ? openHere(item.source.type, item.source.number) : shell.openExternal(item.source.url))
  // One row, the whole of it pressable: what links here first, who and when under it.
  return (
    <ListItem onPress={go}>
      <Stack gap="none">
        <Box direction="row" gap="xs" align="center">
          <Glyph look={sourceLook(item.source)} />
          <Box grow minWidth={0}>
            <Text size="sm" weight="medium" truncate>
              {item.source.title}
            </Text>
          </Box>
          {/* The number keeps its width; the title is what gets cut. */}
          <Box shrink={false}>
            <Text size="sm" muted>
              {own ? `#${item.source.number}` : `${item.source.repo}#${item.source.number}`}
            </Text>
          </Box>
        </Box>
        <Text size="xs" muted>
          {`${item.actor ?? 'ghost'} mentioned this · `}
          <RelativeTime at={item.createdAt} />
        </Text>
      </Stack>
    </ListItem>
  )
}

/** An event in one line: glyph, who, what and when. */
function EventLine({ look, actor, words, at }: { look: Look; actor: string | null; words: string; at: number }) {
  return (
    <Box direction="row" gap="sm" align="center" paddingX="sm">
      <Glyph look={look} />
      <Text size="sm">
        <Text size="sm" weight="semibold">
          {actor ?? 'ghost'}
        </Text>
        <Text size="sm" muted>
          {` ${words} `}
          <RelativeTime at={at} />
        </Text>
      </Text>
    </Box>
  )
}

/** A review's comments on the diff: Orca's Checks tab shows and answers them for the workspace's own
 *  pull request; any other opens on GitHub. */
function DiffComments({ t, r }: { t: AnyThread; r: TimelineReview }) {
  const own = t.kind === 'pulls' && read(t.state).number === focused()?.number
  return (
    <Row gap="xs" align="center" wrap>
      <Text size="xs" muted>
        {`${count(r.comments)} comment${r.comments === 1 ? '' : 's'} on the diff`}
      </Text>
      {own && (
        <Button size="xs" variant="outline" icon="activity" tooltip="Orca's Checks tab answers review threads beside the code" onPress={() => handOff('checks')}>
          Open in Checks
        </Button>
      )}
      <Link onPress={() => shell.openExternal(r.url)}>View on GitHub</Link>
    </Row>
  )
}

/** A review: a box when it says something (a body, or comments on the diff), else one line. */
function ReviewItem({ t, r }: { t: AnyThread; r: TimelineReview }) {
  const { words, look } = reviewLook(r.state)
  if (!r.body.trim() && r.comments === 0) return <EventLine look={look} actor={r.author} words={words} at={r.createdAt} />
  const head = (
    <>
      <Text size="sm" weight="semibold" tone={look.tone}>
        {`${look.glyph} `}
      </Text>
      <Byline who={r.author} words={words} at={r.createdAt} />
    </>
  )
  return (
    <Post t={t} head={head} body={r.body} url={r.url} cut={r.truncated} subject={r.id} reactions={r.reactions} empty={null}>
      {r.comments > 0 && <DiffComments t={t} r={r} />}
    </Post>
  )
}

function Item({ t, item, s }: { t: AnyThread; item: TimelineItem; s: ThreadState<ThreadDetail> }) {
  if (item.kind === 'comment') return <CommentItem t={t} c={item} s={s} />
  if (item.kind === 'mention') return <List label="Mentioned in"><Mention item={item} /></List>
  if (item.kind === 'review') return <ReviewItem t={t} r={item} />
  if (item.kind === 'merged') {
    return <EventLine look={pullLook({ state: 'merged' })} actor={item.actor} words={`merged commit ${item.commit} into ${item.into}`} at={item.createdAt} />
  }
  const { words, look } = stateWords(item)
  return <EventLine look={look} actor={item.actor} words={words} at={item.createdAt} />
}

/** Part of the timeline in order; mentions next to each other share one list. */
function Run({ t, items, s }: { t: AnyThread; items: TimelineItem[]; s: ThreadState<ThreadDetail> }) {
  const runs: TimelineItem[][] = []
  for (const item of items) {
    const last = runs.at(-1)
    if (item.kind === 'mention' && last?.[0].kind === 'mention') last.push(item)
    else runs.push([item])
  }
  return (
    <>
      {runs.map((run) =>
        run[0].kind === 'mention' ? (
          <List key={run[0].id} label="Mentioned in">
            {run.map((item) => (
              <Mention key={item.id} item={item as TimelineMention} />
            ))}
          </List>
        ) : (
          <Item key={run[0].id} t={t} item={run[0]} s={s} />
        )
      )}
    </>
  )
}

/** The timeline: its start, Load more with how many are between, and its latest items. */
export function Timeline({ t, d, s }: { t: AnyThread; d: ThreadDetail; s: ThreadState<ThreadDetail> }) {
  const hidden = hiddenCount(d)
  return (
    <>
      <Run t={t} items={d.head} s={s} />
      {hidden > 0 && (
        <Row gap="xs" align="center">
          <Button size="sm" variant="outline" disabled={!!s.busy} onPress={t.loadMore}>
            {`Load more (${count(hidden)})`}
          </Button>
          {s.busy === 'more' && <Spinner label="Loading more" labelHidden />}
        </Row>
      )}
      <Run t={t} items={d.tail} s={s} />
    </>
  )
}

/** Choices drawn at most, so a big org stays quick; the filter finds the rest. */
const SHOWN = 50

/** One line: the name in a fixed column, the values beside it, and a pencil when it can be edited. */
export function MetaLine({ label, empty, onEdit, children }: { label: string; empty: string; onEdit?: () => unknown; children?: OrcaNode }) {
  const values = [children].flat(3).filter((c) => c !== false && c !== null && c !== undefined)
  return (
    <Box direction="row" align="center" gap="sm">
      <Box width={72} shrink={false}>
        <Text size="xs" muted>
          {label}
        </Text>
      </Box>
      <Box grow minWidth={0} direction="row" gap="xs" wrap align="center">
        {values.length > 0 ? (
          children
        ) : (
          <Text size="sm" muted>
            {empty}
          </Text>
        )}
      </Box>
      {onEdit && <IconButton icon="edit" label={`Edit ${label.toLowerCase()}`} size="sm" variant="ghost" onPress={onEdit} />}
    </Box>
  )
}

/** Checkboxes over the repo's labels or assignable logins, with a filter; Apply sends the change. */
export function PickerBox({ ops, picking, busy }: { ops: PickerOps; picking: Picking; busy: boolean }) {
  const c = read(choices)
  const known = picking.kind === 'labels' ? c.labels : c.assignees
  const query = picking.query.trim().toLowerCase()
  // What is picked shows even when the repo's list lacks it, such as a login typed in.
  const all = known === null ? picking.selected : [...picking.selected.filter((x) => !known.includes(x)), ...known]
  const matching = all.filter((x) => x.toLowerCase().includes(query))
  const noun = picking.kind === 'labels' ? 'labels' : 'people'
  return (
    <Box border radius="md" padding="sm" gap="sm">
      <Input
        label={`Filter ${noun}`}
        labelHidden
        type="search"
        placeholder={`Filter ${noun}`}
        value={picking.query}
        onChange={(value) => ops.change((p) => ({ ...p, query: value }))}
      />
      <Box maxHeight={180} scroll="y" gap="xs">
        {known === null && <Spinner label={`Loading ${noun}`} />}
        {matching.slice(0, SHOWN).map((name) => (
          <Checkbox key={name} label={name} checked={picking.selected.includes(name)} onChange={(on) => ops.toggle(name, on)} />
        ))}
        {known !== null && matching.length === 0 && (
          <Text size="sm" muted>
            {`No ${noun} match.`}
          </Text>
        )}
        {matching.length > SHOWN && (
          <Text size="xs" muted>
            {`${matching.length - SHOWN} more: type to filter`}
          </Text>
        )}
      </Box>
      {picking.kind === 'assignees' && (
        <Input
          label="Add by login"
          placeholder="login, then Enter"
          value={picking.login}
          onChange={(value) => ops.change((p) => ({ ...p, login: value }))}
          onSubmit={ops.addLogin}
        />
      )}
      <Row gap="xs" align="center">
        <Button size="sm" variant="solid" disabled={busy} onPress={ops.apply}>
          Apply
        </Button>
        <Button size="sm" variant="ghost" onPress={() => ops.change(() => null)}>
          Cancel
        </Button>
        {busy && <Spinner label="Saving" labelHidden />}
      </Row>
    </Box>
  )
}

/** Labels and assignees with their pencils and pickers, then whatever else the kind shows. */
export function LabelsAndAssignees({ t, d, s }: { t: AnyThread; d: ThreadDetail; s: ThreadState<ThreadDetail> }) {
  const edit = (kind: 'labels' | 'assignees') => (d.canEdit ? () => t.openPicker(kind) : undefined)
  return (
    <>
      <MetaLine label="Labels" empty="None" onEdit={edit('labels')}>
        {d.labels.map((l) => (
          <Badge key={l}>{l}</Badge>
        ))}
      </MetaLine>
      {s.picking?.kind === 'labels' && <PickerBox ops={t.picker} picking={s.picking} busy={s.busy === 'labels'} />}
      <MetaLine label="Assignees" empty="No one" onEdit={edit('assignees')}>
        {d.assignees.length > 0 && <Text size="sm">{d.assignees.join(', ')}</Text>}
      </MetaLine>
      {s.picking?.kind === 'assignees' && <PickerBox ops={t.picker} picking={s.picking} busy={s.busy === 'assignees'} />}
    </>
  )
}

export function EditTitle({ t, d, s }: { t: AnyThread; d: ThreadDetail; s: ThreadState<ThreadDetail> }) {
  const editing = s.editing!
  return (
    <Stack gap="sm">
      <Input label="Title" value={editing.title} invalid={!editing.title.trim()} onChange={(title) => t.setEditing({ title })} />
      {/* A body cut to fit the panel would lose its end if saved, so it is edited on GitHub. */}
      <Textarea label="Body" rows={10} value={editing.body} disabled={d.truncated} onChange={(body) => t.setEditing({ body })} />
      {d.truncated && (
        <Text size="xs" muted>
          This body is too long to edit here. Edit it on GitHub.
        </Text>
      )}
      <Row gap="xs" align="center">
        <Button size="sm" variant="solid" disabled={!editing.title.trim() || !!s.busy} onPress={t.saveEdit}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onPress={t.cancelEdit}>
          Cancel
        </Button>
        {s.busy === 'edit' && <Spinner label="Saving" labelHidden />}
      </Row>
    </Stack>
  )
}
