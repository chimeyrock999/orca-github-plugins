// One pull request as GitHub shows it: title, state, base ← head, its review decision and merge
// state, reviewers, labels and assignees, the checks of its head commit, the body, then the timeline
// of comments, reviews and events, and a box to comment, review, close or reopen.
import {
  Box,
  Button,
  Callout,
  Code,
  Collapsible,
  EmptyState,
  IconButton,
  List,
  ListItem,
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
import { checkLook, checkSummary, count, decisionLook, duration, mergeLook, pullLook, type Look } from './look'
import { Glyph, Problem } from './parts'
import type { Check, PullDetail, ReviewEvent } from './protocol'
import {
  backToFocus,
  canReview,
  cancelReview,
  dismissHandOff,
  focused,
  handOff,
  handOffError,
  ownPull,
  pull,
  pulls,
  setReview,
  startReview,
  submitReview,
  type PullState
} from './pull-store'
import { lists, repo } from './store'
import { Byline, EditTitle, LabelsAndAssignees, MetaLine, Post, Timeline } from './thread-view'

/** A state's glyph and its words. */
function Status({ look }: { look: Look }) {
  return (
    <Row gap="xs" align="center">
      <Glyph look={look} />
      <Text size="sm">{look.label}</Text>
    </Row>
  )
}

function CheckRow({ c }: { c: Check }) {
  const look = checkLook(c.state)
  const when = c.state === 'pending' ? 'running' : c.durationMs === null ? '' : duration(c.durationMs)
  return (
    <ListItem disabled={!c.url} onPress={() => (c.url ? shell.openExternal(c.url) : undefined)}>
      <Box direction="row" gap="sm" align="center">
        <Glyph look={look} />
        <Box grow minWidth={0}>
          <Text size="sm" truncate>
            {c.name}
          </Text>
        </Box>
        <Box shrink={false}>
          <Text size="xs" muted>
            {when}
          </Text>
        </Box>
      </Box>
    </ListItem>
  )
}

/** The head commit's checks, folded under their summary; open when one fails. */
function Checks({ d }: { d: PullDetail }) {
  if (d.checksTotal === 0) return null
  const failing = d.checks.some((c) => c.state === 'fail')
  // Keyed on whether one fails, so a reload that brings a failure opens it again.
  return (
    <Collapsible key={`${d.number}-${failing}`} title="Checks" description={checkSummary(d.checks, d.checksTotal)} defaultOpen={failing}>
      <List label="Checks">
        {d.checks.map((c, i) => (
          <CheckRow key={`${c.name}-${i}`} c={c} />
        ))}
      </List>
    </Collapsible>
  )
}

function Meta({ d, s }: { d: PullDetail; s: PullState }) {
  const open = d.state === 'open' || d.state === 'draft'
  return (
    <Stack gap="xs">
      <MetaLine label="Review" empty="">
        <Status look={decisionLook(d.review)} />
      </MetaLine>
      {open && (
        <MetaLine label="Merge" empty="">
          <Status look={mergeLook(d.merge)} />
        </MetaLine>
      )}
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

function Composer({ d, s }: { d: PullDetail; s: PullState }) {
  const typed = !!s.draft.trim()
  const open = d.state === 'open' || d.state === 'draft'
  const reviewing = !!s.reviewing
  return (
    <Stack gap="sm">
      {/* While a review is written, the text is its body: Enter sends nothing alone. */}
      <Textarea label="Comment" labelHidden placeholder="Leave a comment (Markdown)" rows={4} value={s.draft} disabled={!!s.busy} onChange={pulls.setDraft} onSubmit={() => (reviewing ? undefined : pulls.sendComment())} />
      <Row justify="end" align="center" gap="xs">
        {s.busy === 'comment' && <Spinner label="Sending" labelHidden />}
        {open && (
          <Button size="sm" variant="outline" disabled={!!s.busy || reviewing} onPress={startReview}>
            Review…
          </Button>
        )}
        <Button size="sm" variant="solid" disabled={!typed || !!s.busy || reviewing} onPress={pulls.sendComment}>
          Comment
        </Button>
      </Row>
      {/* A reload may find it merged or closed meanwhile; then the review no longer fits. */}
      {reviewing && open && <ReviewBox d={d} s={s} />}
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
      <Checks d={d} />
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

function HandOffProblem() {
  const error = read(handOffError)
  return error ? <Problem error={error} onRetry={dismissHandOff} retryLabel="Dismiss" /> : null
}

/** Tasks: Orca's own page lists, searches and filters the repo's pull requests. */
function TasksButton() {
  return (
    <Button size="sm" variant="outline" icon="layers" tooltip="Orca's Tasks page: every pull request of the repo" onPress={() => handOff('tasks')}>
      Tasks
    </Button>
  )
}

/** No pull request open: still looking for the workspace's, or it has none. */
function NoPull() {
  const f = focused()
  const r = read(repo)
  if (!f) return <Skeleton lines={6} label="Finding this workspace's pull request" />
  return (
    <Stack gap="md">
      <EmptyState
        icon="branch"
        title="No pull request for this branch"
        description="Open one from Orca or GitHub, then Refresh. Orca's Tasks page lists the repo's pull requests."
      />
      <Row gap="xs" justify="center">
        <TasksButton />
        <Button size="sm" variant="outline" icon="open-external" onPress={() => (r?.ok ? shell.openExternal(`${r.url}/pulls`) : undefined)}>
          Open on GitHub
        </Button>
      </Row>
      <HandOffProblem />
    </Stack>
  )
}

export function PullView() {
  const s = read(pull)
  const d = s.answer?.ok ? s.answer.detail : null
  const own = focused()?.number ?? null
  return (
    <Box grow minHeight={0} gap="sm">
      <Row justify="between" align="center">
        <Row gap="xs">
          {/* A pull request opened from a mention leads back to the workspace's own. */}
          {s.number !== own && (
            <Button size="sm" variant="outline" onPress={backToFocus}>
              {own ? `← Back to #${own}` : '← Back'}
            </Button>
          )}
          <TasksButton />
        </Row>
        <Toolbar label="Pull request" gap="xs">
          {d?.canEdit && !s.editing && <IconButton icon="edit" label="Edit title and body" variant="ghost" onPress={pulls.startEdit} />}
          <IconButton icon="open-external" label="Open on GitHub" variant="ghost" disabled={!d} onPress={() => (d ? shell.openExternal(d.url) : undefined)} />
        </Toolbar>
      </Row>
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

/** The Pull requests tab: the workspace's pull request (or one opened from a mention), or why there
 *  is none. */
export function PullsTab() {
  const open = read(lists.pulls).open
  return open ? <PullView /> : <NoPull />
}
