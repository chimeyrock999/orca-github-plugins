// One pull request as GitHub shows it: title, state, base ← head, its review decision, merge state
// and checks in one line each (Orca's words), reviewers, labels and assignees, the body, the timeline
// of comments, reviews and events, and a box to comment or review; one you may edit goes ready or
// back to draft.
import {
  Box,
  Button,
  Callout,
  Code,
  IconButton,
  Link,
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
  Toolbar
} from 'orca'
import { checkSummary, checksLook, count, decisionLook, mergeLook, pullLook, type Look } from '../../shared/look'
import { Glyph, Problem } from '../parts'
import type { PullDetail, ReviewEvent } from '../../shared/protocol'
import { backFrom, handOff } from '../linked/link-store'
import { backLabel, HandOffProblem, LinkedView, TasksButton } from '../linked/linked-view'
import {
  canReview,
  canToggleDraft,
  cancelDraft,
  cancelReview,
  ownPull,
  pull,
  pulls,
  setReady,
  setReview,
  startDraft,
  startReview,
  submitReview,
  workspacePull,
  type PullState
} from './pull-store'
import { lists } from '../store'
import { Byline, EditTitle, LabelsAndAssignees, MetaLine, Post, Timeline } from '../thread/thread-view'

/** A state's glyph and its words. */
function Status({ look }: { look: Look }) {
  return (
    <Row gap="xs" align="center">
      <Glyph look={look} />
      <Text size="sm">{look.label}</Text>
    </Row>
  )
}

/** One line for the checks; the workspace's pull request hands off to Orca's Checks tab, which
 *  lists them with logs and reruns, any other opens its checks on GitHub. */
function ChecksLine({ d }: { d: PullDetail }) {
  if (!d.checks) return null
  const own = d.number === workspacePull() && read(pull).repo === null
  return (
    <MetaLine label="Checks" empty="">
      {/* One unwrapped row: the glyph stays beside the line when its words wrap. */}
      <Row gap="xs" align="center">
        <Glyph look={checksLook(d.checks)} />
        <Link onPress={() => (own ? handOff('checks') : shell.openExternal(`${d.url}/checks`))}>{checkSummary(d.checks)}</Link>
      </Row>
    </MetaLine>
  )
}

function Meta({ d, s }: { d: PullDetail; s: PullState }) {
  const open = d.state === 'open' || d.state === 'draft'
  return (
    <Stack gap="xs">
      {d.review && (
        <MetaLine label="Review" empty="">
          <Status look={decisionLook(d.review)} />
        </MetaLine>
      )}
      {open && (
        <MetaLine label="Merge" empty="">
          <Status look={mergeLook(d.merge, d.checks)} />
        </MetaLine>
      )}
      <ChecksLine d={d} />
      <MetaLine label="Reviewers" empty="None waiting">
        {d.reviewers.length > 0 && <Text size="sm">{d.reviewers.join(', ')}</Text>}
      </MetaLine>
      <LabelsAndAssignees t={pulls} d={d} s={s} />
      <MetaLine label="Milestone" empty="None">
        {d.milestone && <Text size="sm">{d.milestone}</Text>}
      </MetaLine>
    </Stack>
  )
}

const REVIEWS: { value: ReviewEvent; label: string; description: string }[] = [
  { value: 'comment', label: 'Comment', description: 'General feedback without approving' },
  { value: 'approve', label: 'Approve', description: 'Approve merging these changes' },
  { value: 'request_changes', label: 'Request changes', description: 'Feedback that must be addressed before merging' }
]

function ReviewBox({ d, s }: { d: PullDetail; s: PullState }) {
  const event = s.reviewing!
  const own = ownPull(d)
  const typed = !!s.draft.trim()
  const hint = typed
    ? 'The text in the box is the review.'
    : event === 'approve'
      ? 'Text in the box, if any, goes with the approval.'
      : 'Write the review in the box above first.'
  return (
    <Callout tone="neutral" title={`Review #${d.number}`}>
      <Stack gap="sm">
        <RadioGroup
          label="Review"
          labelHidden
          value={event}
          options={REVIEWS.map((r) => ({ ...r, disabled: own && r.value !== 'comment' }))}
          onChange={(value) => setReview(value as ReviewEvent)}
        />
        {own && (
          <Text size="xs" muted>
            You cannot approve or request changes on your own pull request.
          </Text>
        )}
        <Text size="xs" muted>
          {hint}
        </Text>
        <Row gap="xs" align="center" wrap>
          <Button size="sm" variant="solid" disabled={!canReview(d, event, s.draft) || !!s.busy} onPress={submitReview}>
            Submit review
          </Button>
          <Button size="sm" variant="ghost" onPress={cancelReview}>
            Cancel
          </Button>
          {s.busy === 'review' && <Spinner label="Submitting" labelHidden />}
        </Row>
      </Stack>
    </Callout>
  )
}

/** Asks before the pull request goes back to draft. */
function DraftBox({ d, s }: { d: PullDetail; s: PullState }) {
  return (
    <Callout tone="warning" title={`Convert #${d.number} to draft?`}>
      <Stack gap="sm">
        <Text size="xs" muted>
          It cannot be merged until it is marked ready for review again.
        </Text>
        <Row gap="xs" align="center" wrap>
          <Button size="sm" variant="solid" disabled={!!s.busy} onPress={() => setReady(false)}>
            Convert to draft
          </Button>
          <Button size="sm" variant="ghost" onPress={cancelDraft}>
            Cancel
          </Button>
          {s.busy === 'draft' && <Spinner label="Converting" labelHidden />}
        </Row>
      </Stack>
    </Callout>
  )
}

/** A pull request you may edit: a draft is marked ready in one press, an open one goes back to draft
 *  once confirmed. */
function DraftButton({ d, s }: { d: PullDetail; s: PullState }) {
  if (!canToggleDraft(d)) return <Box />
  return d.state === 'draft' ? (
    <Row gap="xs" align="center">
      <Button size="sm" variant="outline" disabled={!!s.busy || !!s.reviewing} onPress={() => setReady(true)}>
        Ready for review
      </Button>
      {s.busy === 'ready' && <Spinner label="Marking ready" labelHidden />}
    </Row>
  ) : (
    <Button size="sm" variant="outline" disabled={!!s.busy || !!s.reviewing || s.toDraft} onPress={startDraft}>
      Convert to draft…
    </Button>
  )
}

function Composer({ d, s }: { d: PullDetail; s: PullState }) {
  const typed = !!s.draft.trim()
  const open = d.state === 'open' || d.state === 'draft'
  const reviewing = !!s.reviewing
  return (
    <Stack gap="sm">
      {/* While a review is written, the text is its body: Enter sends nothing alone. */}
      <Textarea label="Comment" labelHidden placeholder="Leave a comment (Markdown)" rows={4} value={s.draft} disabled={!!s.busy} onChange={pulls.setDraft} onSubmit={() => (reviewing ? undefined : pulls.sendComment())} />
      <Row justify="between" align="center" gap="xs" wrap>
        <DraftButton d={d} s={s} />
        <Row gap="xs" align="center">
          {s.busy === 'comment' && <Spinner label="Sending" labelHidden />}
          {open && (
            <Button size="sm" variant="outline" disabled={!!s.busy || reviewing || s.toDraft} onPress={startReview}>
              Review…
            </Button>
          )}
          <Button size="sm" variant="solid" disabled={!typed || !!s.busy || reviewing} onPress={pulls.sendComment}>
            Comment
          </Button>
        </Row>
      </Row>
      {/* A reload may find it merged or closed meanwhile; then the review no longer fits. */}
      {reviewing && open && <ReviewBox d={d} s={s} />}
      {s.toDraft && d.state === 'open' && canToggleDraft(d) && <DraftBox d={d} s={s} />}
    </Stack>
  )
}

function Detail({ d, s }: { d: PullDetail; s: PullState }) {
  const look = pullLook(d)
  return (
    <Box grow minHeight={0} scroll="y" gap="md">
      {s.editing ? (
        <EditTitle t={pulls} d={d} s={s} />
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
      <Row gap="xs" align="center" wrap>
        <Code>{d.baseRef}</Code>
        <Text size="sm" muted>
          ←
        </Text>
        <Code>{d.headRef}</Code>
      </Row>
      <Meta d={d} s={s} />
      {!s.editing && (
        <Post t={pulls} head={<Byline who={d.author} words="opened" at={d.createdAt} />} body={d.body} url={d.url} cut={d.truncated} subject={d.id} reactions={d.reactions} />
      )}
      <Separator />
      <Timeline t={pulls} d={d} s={s} />
      {s.error && <Problem error={s.error} onRetry={pulls.dismissError} retryLabel="Dismiss" />}
      <Composer d={d} s={s} />
    </Box>
  )
}

export function PullView() {
  const s = read(pull)
  const d = s.answer?.ok ? s.answer.detail : null
  // A pull request opened from a mention or the list leads back to the workspace's own, or the list.
  const back = backLabel(pulls)
  return (
    <Box grow minHeight={0} gap="sm">
      <Row justify="between" align="center" wrap>
        <TasksButton kind="pulls" back />
        {/* Kept whole, so the two buttons do not stack; narrower still, they wrap under Tasks. */}
        <Box shrink={false}>
          <Toolbar label="Pull request" gap="xs">
            {d?.canEdit && !s.editing && <IconButton icon="edit" label="Edit title and body" variant="ghost" onPress={pulls.startEdit} />}
            <IconButton icon="open-external" label="Open on GitHub" variant="ghost" disabled={!d} onPress={() => (d ? shell.openExternal(d.url) : undefined)} />
          </Toolbar>
        </Box>
      </Row>
      {back && (
        <Row>
          <Button size="sm" variant="outline" onPress={() => backFrom(pulls)}>
            {back}
          </Button>
        </Row>
      )}
      <HandOffProblem />
      {s.answer === null ? (
        <Skeleton lines={8} label={`Loading pull request ${s.number}`} />
      ) : !s.answer.ok ? (
        <Problem error={s.answer.error} onRetry={pulls.load} />
      ) : (
        <Detail d={s.answer.detail} s={s} />
      )}
    </Box>
  )
}

/** The Pull requests tab: a pull request (the workspace's, one from its list or a mention), else the
 *  linked list or why there is none. */
export function PullsTab() {
  const open = read(lists.pulls).open
  return open ? <PullView /> : <LinkedView t={pulls} />
}
