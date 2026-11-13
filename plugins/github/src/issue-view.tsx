// One issue as GitHub shows it: title, state, labels, assignees and milestone, the body, then the
// timeline of comments, mentions and state changes, and a box to comment, close or reopen.
import {
  Badge,
  Box,
  Button,
  Callout,
  IconButton,
  Input,
  Link,
  List,
  ListItem,
  Markdown,
  RadioGroup,
  read,
  RelativeTime,
  Row,
  Separator,
  shell,
  Skeleton,
  Spinner,
  Stack,
  Text,
  Textarea,
  Toolbar,
  type OrcaNode
} from 'orca'
import { EditIssue, MetaLine, PickerBox } from './issue-forms'
import {
  askDelete,
  backToIssues,
  cancelClose,
  cancelDelete,
  cancelEditComment,
  confirmClose,
  confirmDelete,
  dismissError,
  duplicateNumber,
  hiddenCount,
  issue,
  loadIssue,
  loadMore,
  openIssue,
  openPicker,
  react,
  reopen,
  saveComment,
  sendComment,
  setClosing,
  setCommentDraft,
  setDraft,
  startClose,
  startEdit,
  startEditComment,
  toggleReactions,
  type IssueState
} from './issue-store'
import { count, EMOJI, issueLook, reactionTip, sourceLook, stateWords } from './look'
import { Glyph, Problem } from './parts'
import { REACTIONS, type CloseReason, type IssueDetail, type ReactionGroup, type TimelineComment, type TimelineItem, type TimelineMention } from './protocol'
import { hasImage, linkRefs } from './refs'
import { repo } from './store'

function repoUrl(): string {
  const r = read(repo)
  return r?.ok ? r.url : 'https://github.com'
}

function Reactions({ subject, groups }: { subject: string; groups: ReactionGroup[] }) {
  const s = read(issue)
  const open = s.reacting === subject
  const viewer = s.answer?.ok ? s.answer.issue.viewer : null
  return (
    <Stack gap="xs">
      <Row gap="xs" wrap>
        {groups.map((g) => (
          <Button
            key={g.content}
            size="xs"
            variant={g.viewerHasReacted ? 'outline' : 'ghost'}
            tooltip={reactionTip(g, viewer)}
            onPress={() => react(subject, g.content)}
          >
            {`${EMOJI[g.content]} ${g.count}`}
          </Button>
        ))}
        <Button size="xs" variant={open ? 'outline' : 'ghost'} tooltip="Add reaction" onPress={() => toggleReactions(subject)}>
          ☺+
        </Button>
      </Row>
      {open && (
        <Toolbar label="Reactions" gap="xs">
          {REACTIONS.map((content) => (
            <Button key={content} size="xs" variant="ghost" tooltip={content.toLowerCase().replace('_', ' ')} onPress={() => react(subject, content)}>
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
function Post({ head, tools, body, url, cut, subject, reactions }: {
  head: OrcaNode
  tools?: OrcaNode
  body: string
  url: string
  cut: boolean
  subject: string
  reactions: ReactionGroup[]
}) {
  // Reactions sit under the box, as on GitHub, not inside it.
  return (
    <Stack gap="xs">
      <Box border radius="md">
        <Box direction="row" justify="between" align="center" gap="xs" paddingX="sm" paddingY="xs" background="muted">
          <Text size="sm">{head}</Text>
          {tools}
        </Box>
        <Box padding="sm" gap="sm">
          {body.trim() ? <Markdown content={linkRefs(body, repoUrl())} /> : <Text size="sm" muted>No description provided.</Text>}
          {cut && <Cut url={url} />}
          {hasImage(body) && (
            <Text size="xs" muted>
              Images show on GitHub only.
            </Text>
          )}
        </Box>
      </Box>
      <Reactions subject={subject} groups={reactions} />
    </Stack>
  )
}

function CommentItem({ c, s }: { c: TimelineComment; s: IssueState }) {
  if (s.editingComment?.id === c.databaseId) {
    return (
      <Box border radius="md" padding="sm" gap="sm">
        <Textarea label={`Edit ${c.author ?? 'ghost'}'s comment`} rows={6} value={s.editingComment.body} onChange={setCommentDraft} onSubmit={saveComment} />
        <Row gap="xs">
          <Button size="sm" variant="solid" disabled={!s.editingComment.body.trim() || !!s.busy} onPress={saveComment}>
            Update comment
          </Button>
          <Button size="sm" variant="ghost" onPress={cancelEditComment}>
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
      {c.canEdit && !c.truncated && <IconButton icon="edit" label="Edit comment" size="sm" variant="ghost" onPress={() => startEditComment(c)} />}
      {c.canDelete && <IconButton icon="delete" label="Delete comment" size="sm" variant="ghost" onPress={() => askDelete(c.databaseId)} />}
    </Toolbar>
  )
  const head = (
    <>
      <Text size="sm" weight="semibold">
        {c.author ?? 'ghost'}
      </Text>
      <Text size="sm" muted>
        {' commented '}
        <RelativeTime at={c.createdAt} />
        {c.edited ? ' · edited' : ''}
      </Text>
    </>
  )
  return (
    <Stack gap="xs">
      <Post head={head} tools={tools} body={c.body} url={c.url} cut={c.truncated} subject={c.id} reactions={c.reactions} />
      {s.deleting === c.databaseId && (
        <Callout tone="danger" title="Delete this comment?">
          <Stack gap="sm">
            <Text size="sm">This cannot be undone.</Text>
            <Row gap="xs">
              <Button size="sm" variant="solid" tone="danger" disabled={!!s.busy} onPress={confirmDelete}>
                Delete
              </Button>
              <Button size="sm" variant="ghost" onPress={cancelDelete}>
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

function Mention({ item }: { item: TimelineMention }) {
  const r = read(repo)
  const own = r?.ok && item.source.repo.toLowerCase() === r.nameWithOwner.toLowerCase()
  // Issues of this repo open here; pull requests and other repos open on GitHub.
  const go = () => (own && item.source.type === 'issue' ? openIssue(item.source.number) : shell.openExternal(item.source.url))
  // One row, the whole of it pressable: what links here first, who and when under it.
  return (
    <ListItem icon="link" onPress={go}>
      <Stack gap="none">
        <Box direction="row" gap="xs" align="center">
          <Glyph look={sourceLook(item.source)} />
          <Box grow minWidth={0}>
            <Text size="sm" weight="medium" truncate>
              {item.source.title}
            </Text>
          </Box>
          <Text size="sm" muted>
            {own ? `#${item.source.number}` : `${item.source.repo}#${item.source.number}`}
          </Text>
        </Box>
        <Text size="xs" muted>
          {`${item.actor ?? 'ghost'} mentioned this · `}
          <RelativeTime at={item.createdAt} />
        </Text>
      </Stack>
    </ListItem>
  )
}

/** The timeline in order; mentions next to each other share one list. */
function Timeline({ items, s }: { items: TimelineItem[]; s: IssueState }) {
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
          <Item key={run[0].id} item={run[0]} s={s} />
        )
      )}
    </>
  )
}

function Item({ item, s }: { item: TimelineItem; s: IssueState }) {
  if (item.kind === 'comment') return <CommentItem c={item} s={s} />
  if (item.kind === 'mention') return <List label="Mentioned in"><Mention item={item} /></List>
  const { words, look } = stateWords(item)
  return (
    <Box direction="row" gap="sm" align="center" paddingX="sm">
      <Glyph look={look} />
      <Text size="sm">
        <Text size="sm" weight="semibold">
          {item.actor ?? 'ghost'}
        </Text>
        <Text size="sm" muted>
          {` ${words} `}
          <RelativeTime at={item.createdAt} />
        </Text>
      </Text>
    </Box>
  )
}

const REASONS: { value: CloseReason; label: string; description: string; button: string }[] = [
  { value: 'completed', label: 'Completed', description: 'Done, closed, fixed, resolved', button: 'Close as completed' },
  { value: 'not planned', label: 'Not planned', description: "Won't fix, can't repro, stale", button: 'Close as not planned' },
  { value: 'duplicate', label: 'Duplicate', description: 'Same as another issue', button: 'Close as duplicate' }
]

function CloseBox({ d, s }: { d: IssueDetail; s: IssueState }) {
  const closing = s.closing!
  const reason = REASONS.find((r) => r.value === closing.reason) ?? REASONS[0]
  const withComment = s.draft.trim() ? ' with comment' : ''
  const blocked = closing.reason === 'duplicate' && duplicateNumber(closing.duplicateOf) === null
  return (
    <Callout tone="warning" title={`Close #${d.number}${withComment}?`}>
      <Stack gap="sm">
        <RadioGroup label="Reason" value={closing.reason} options={REASONS.map(({ value, label, description }) => ({ value, label, description }))} onChange={(value) => setClosing({ reason: value as CloseReason })} />
        {closing.reason === 'duplicate' && (
          <Input label="Duplicate of" placeholder="Issue number, such as 97" value={closing.duplicateOf} onChange={(value) => setClosing({ duplicateOf: value })} />
        )}
        <Row gap="xs" wrap>
          <Button size="sm" variant="solid" disabled={blocked || !!s.busy} onPress={confirmClose}>
            {reason.button}
          </Button>
          <Button size="sm" variant="ghost" onPress={cancelClose}>
            Cancel
          </Button>
          {s.busy === 'close' && <Spinner label="Closing" labelHidden />}
        </Row>
      </Stack>
    </Callout>
  )
}

function Composer({ d, s }: { d: IssueDetail; s: IssueState }) {
  const typed = !!s.draft.trim()
  const sending = s.busy === 'comment' || s.busy === 'reopen'
  return (
    <Stack gap="sm">
      <Textarea label="Comment" labelHidden placeholder="Leave a comment (Markdown)" rows={4} value={s.draft} disabled={!!s.busy} onChange={setDraft} onSubmit={sendComment} />
      <Row justify="between" align="center" wrap>
        {d.canEdit ? (
          d.state === 'open' ? (
            <Button size="sm" variant="outline" disabled={!!s.busy || !!s.closing} onPress={startClose}>
              {typed ? 'Close with comment…' : 'Close issue…'}
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={!!s.busy} onPress={reopen}>
              {typed ? 'Reopen with comment' : 'Reopen issue'}
            </Button>
          )
        ) : (
          <Box />
        )}
        <Row gap="xs" align="center">
          {sending && <Spinner label="Sending" labelHidden />}
          <Button size="sm" variant="solid" disabled={!typed || !!s.busy} onPress={sendComment}>
            Comment
          </Button>
        </Row>
      </Row>
      {s.closing && <CloseBox d={d} s={s} />}
    </Stack>
  )
}

function Meta({ d, s }: { d: IssueDetail; s: IssueState }) {
  const edit = (kind: 'labels' | 'assignees') => (d.canEdit ? () => openPicker(kind) : undefined)
  return (
    <Stack gap="xs">
      <MetaLine label="Labels" empty="None" onEdit={edit('labels')}>
        {d.labels.map((l) => (
          <Badge key={l}>{l}</Badge>
        ))}
      </MetaLine>
      {s.picking?.kind === 'labels' && <PickerBox where="issue" picking={s.picking} busy={s.busy === 'labels'} />}
      <MetaLine label="Assignees" empty="No one" onEdit={edit('assignees')}>
        {d.assignees.length > 0 && <Text size="sm">{d.assignees.join(', ')}</Text>}
      </MetaLine>
      {s.picking?.kind === 'assignees' && <PickerBox where="issue" picking={s.picking} busy={s.busy === 'assignees'} />}
      <MetaLine label="Milestone" empty="None">
        {d.milestone && <Text size="sm">{d.milestone}</Text>}
      </MetaLine>
    </Stack>
  )
}

function Detail({ d, s }: { d: IssueDetail; s: IssueState }) {
  const look = issueLook(d)
  const hidden = hiddenCount(d)
  const opened = (
    <>
      <Text size="sm" weight="semibold">
        {d.author ?? 'ghost'}
      </Text>
      <Text size="sm" muted>
        {' opened '}
        <RelativeTime at={d.createdAt} />
      </Text>
    </>
  )
  return (
    <Box grow minHeight={0} scroll="y" gap="md">
      {s.editing ? (
        <EditIssue d={d} s={s} />
      ) : (
        <Text size="md" weight="semibold">
          {d.title}
        </Text>
      )}
      <Row gap="xs" align="center" wrap>
        <Glyph look={look} />
        <Text size="sm" tone={look.tone}>
          {look.label}
        </Text>
        <Text size="sm" muted>
          {`#${d.number} · ${d.author ?? 'ghost'} opened `}
          <RelativeTime at={d.createdAt} />
          {` · ${count(d.comments)} comment${d.comments === 1 ? '' : 's'}`}
        </Text>
      </Row>
      <Meta d={d} s={s} />
      {!s.editing && <Post head={opened} body={d.body} url={d.url} cut={d.truncated} subject={d.id} reactions={d.reactions} />}
      <Separator />
      <Timeline items={d.head} s={s} />
      {hidden > 0 && (
        <Row gap="xs" align="center">
          <Button size="sm" variant="outline" disabled={!!s.busy} onPress={loadMore}>
            {`Load more (${count(hidden)})`}
          </Button>
          {s.busy === 'more' && <Spinner label="Loading more" labelHidden />}
        </Row>
      )}
      <Timeline items={d.tail} s={s} />
      {s.error && <Problem error={s.error} onRetry={dismissError} retryLabel="Dismiss" />}
      <Composer d={d} s={s} />
    </Box>
  )
}

export function IssueView() {
  const s = read(issue)
  const d = s.answer?.ok ? s.answer.issue : null
  return (
    <Box grow minHeight={0} gap="sm">
      <Row justify="between" align="center">
        <Button size="sm" variant="outline" onPress={backToIssues}>
          ← Back to issues
        </Button>
        <Toolbar label="Issue" gap="xs">
          {d?.canEdit && !s.editing && <IconButton icon="edit" label="Edit title and body" variant="ghost" onPress={startEdit} />}
          <IconButton icon="open-external" label="Open on GitHub" variant="ghost" disabled={!d} onPress={() => (d ? shell.openExternal(d.url) : undefined)} />
        </Toolbar>
      </Row>
      {s.answer === null ? (
        <Skeleton lines={8} label={`Loading issue ${s.number}`} />
      ) : !s.answer.ok ? (
        <Problem error={s.answer.error} onRetry={loadIssue} />
      ) : (
        <Detail d={s.answer.issue} s={s} />
      )}
    </Box>
  )
}
