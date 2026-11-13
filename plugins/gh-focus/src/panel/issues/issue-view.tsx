// One issue as GitHub shows it: title, state, labels, assignees and milestone, the body, then the
// timeline of comments, mentions and state changes, and a box to comment, close or reopen.
import { Box, Button, Callout, Input, RadioGroup, read, RelativeTime, Row, Separator, Skeleton, Spinner, Stack, Text, Textarea } from 'orca'
import {
  cancelClose,
  confirmClose,
  duplicateNumber,
  issue,
  issues,
  loadIssue,
  reopen,
  setClosing,
  startClose,
  type IssueState
} from './issue-store'
import { count, issueLook } from '../../shared/look'
import { backFrom } from '../linked/link-store'
import { backLabel, HandOffProblem, ThreadTop } from '../linked/linked-view'
import { Glyph, Problem } from '../parts'
import type { CloseReason, IssueDetail } from '../../shared/protocol'
import { Byline, LabelsAndAssignees, MetaLine, Post, Timeline, TitleRow } from '../thread/thread-view'

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
      <Textarea label="Comment" labelHidden placeholder="Leave a comment (Markdown)" rows={4} value={s.draft} disabled={!!s.busy} onChange={issues.setDraft} onSubmit={issues.sendComment} />
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
          <Button size="sm" variant="solid" disabled={!typed || !!s.busy} onPress={issues.sendComment}>
            Comment
          </Button>
        </Row>
      </Row>
      {s.closing && <CloseBox d={d} s={s} />}
    </Stack>
  )
}

function Detail({ d, s }: { d: IssueDetail; s: IssueState }) {
  const look = issueLook(d)
  return (
    <Box grow minHeight={0} scroll="y" gap="md">
      <TitleRow t={issues} d={d} s={s} label="Issue" />
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
      <Stack gap="xs">
        <LabelsAndAssignees t={issues} d={d} s={s} />
        <MetaLine label="Milestone" empty="None">
          {d.milestone && <Text size="sm">{d.milestone}</Text>}
        </MetaLine>
      </Stack>
      {!s.editing && (
        <Post t={issues} head={<Byline who={d.author} words="opened" at={d.createdAt} />} body={d.body} url={d.url} cut={d.truncated} subject={d.id} reactions={d.reactions} />
      )}
      <Separator />
      <Timeline t={issues} d={d} s={s} />
      {s.error && <Problem error={s.error} onRetry={issues.dismissError} retryLabel="Dismiss" />}
      <Composer d={d} s={s} />
    </Box>
  )
}

export function IssueView() {
  const s = read(issue)
  const back = backLabel(issues)
  return (
    <Box grow minHeight={0} gap="sm">
      <ThreadTop kind="issues" back={back} onBack={() => backFrom(issues)} />
      <HandOffProblem />
      {s.answer === null ? (
        <Skeleton lines={8} label={`Loading issue ${s.number}`} />
      ) : !s.answer.ok ? (
        <Problem error={s.answer.error} onRetry={loadIssue} />
      ) : (
        <Detail d={s.answer.detail} s={s} />
      )}
    </Box>
  )
}
