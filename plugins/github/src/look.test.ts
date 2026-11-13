// The words and tones rows and errors show with.
import { assert, test } from 'orca/testing'
import { count, duration, pageLine, issueLook, itemEvent, problemOf, pullLook, reactionTip, runCause, runLook, stateWords } from './look'
import type { IssueRow, PullRow, RunRow } from './protocol'

const issue: IssueRow = { number: 8, title: 't', url: 'u', state: 'open', author: 'mai-t', labels: [], createdAt: 1, closedAt: null }
const pull: PullRow = { ...issue, state: 'open', branch: 'fix/x', mergedAt: null }
const run: RunRow = {
  id: 1,
  runNumber: 296,
  workflow: 'CI',
  title: 't',
  url: 'u',
  state: 'success',
  event: 'push',
  branch: 'main',
  sha: '233b470d3a189e89cf6fa69624e11c3fa9387d81',
  actor: 'mai-t',
  pullNumber: null,
  startedAt: 1,
  durationMs: 1
}

test('states read like GitHub: open green, done and merged in the text colour, failures red', () => {
  assert.deepEqual([issueLook(issue).tone, issueLook({ ...issue, state: 'done' }).tone, issueLook({ ...issue, state: 'not_planned' }).tone], ['success', 'accent', 'neutral'])
  assert.deepEqual(
    (['open', 'draft', 'merged', 'closed'] as const).map((state) => pullLook({ ...pull, state }).tone),
    ['success', 'neutral', 'accent', 'danger']
  )
  assert.deepEqual(
    (['success', 'failure', 'running', 'cancelled'] as const).map((state) => runLook({ ...run, state }).tone),
    ['success', 'danger', 'warning', 'neutral']
  )
  // Done and not planned are told apart by glyph too, not by colour alone.
  assert.notEqual(issueLook({ ...issue, state: 'done' }).glyph, issueLook({ ...issue, state: 'not_planned' }).glyph)
})

test('itemEvent: opened, closed or merged, with its time', () => {
  assert.deepEqual(itemEvent(issue), { verb: 'opened', at: 1 })
  assert.deepEqual(itemEvent({ ...issue, state: 'done', closedAt: 5 }), { verb: 'closed', at: 5 })
  assert.deepEqual(itemEvent({ ...pull, state: 'merged', closedAt: 5, mergedAt: 6 }), { verb: 'merged', at: 6 })
  assert.deepEqual(itemEvent({ ...pull, state: 'draft' }), { verb: 'opened', at: 1 })
})

test('runCause says what started the run', () => {
  assert.equal(runCause(run), 'Commit 233b470 pushed by mai-t')
  assert.equal(runCause({ ...run, event: 'pull_request', pullNumber: 134 }), 'Pull request #134 by mai-t')
  assert.equal(runCause({ ...run, event: 'pull_request_target', pullNumber: null, actor: null }), 'Pull request')
  assert.equal(runCause({ ...run, event: 'schedule' }), 'Scheduled')
  assert.equal(runCause({ ...run, event: 'workflow_dispatch' }), 'Manually run by mai-t')
  assert.equal(runCause({ ...run, event: 'merge_group' }), 'merge group by mai-t')
})

test('duration reads like GitHub', () => {
  assert.equal(duration(57_000), '57s')
  assert.equal(duration(466_000), '7m 46s')
  assert.equal(duration(3_720_000), '1h 2m')
})

test('every error code has words, and an unknown one falls back to gh_failed', () => {
  assert.equal(problemOf({ code: 'gh_logged_out' }).title, 'gh is not logged in')
  assert.equal(problemOf({ code: 'nope' as never }).title, 'gh failed')
})

test("Orca's own failures say what happened", () => {
  assert.deepEqual(
    (['action_failed', 'not_allowed', 'too_large', 'unavailable', 'cancelled', 'host_failed'] as const).map((code) => problemOf({ code }).title),
    ['Panel error', 'Not allowed by Orca', 'Answer too big for the panel', 'Plugin worker not running', 'Request cancelled', 'Orca did not answer']
  )
  assert.ok(!/report/i.test(problemOf({ code: 'not_allowed' }).hint))
})

test("Orca's rate limit says how long to wait, or a moment; GitHub's keeps its words", () => {
  const orca = problemOf({ code: 'host_rate_limited', retryAfterMs: 12_000 })
  assert.equal(orca.title, 'Too many requests')
  assert.match(orca.hint, /Wait 12s, then press Retry/)
  assert.match(problemOf({ code: 'host_rate_limited', retryAfterMs: 90_000 }).hint, /Wait 1m 30s/)
  // Never "Wait 0s".
  assert.match(problemOf({ code: 'host_rate_limited', retryAfterMs: 400 }).hint, /Wait 1s,/)
  assert.match(problemOf({ code: 'host_rate_limited' }).hint, /Wait a moment, then press Retry/)
  assert.equal(problemOf({ code: 'rate_limited' }).title, 'GitHub rate limit reached')
  assert.equal(problemOf({ code: 'rate_limited', retryAfterMs: 5_000 }).title, 'GitHub rate limit reached')
})

test('pageLine counts pages GitHub lets anyone reach', () => {
  assert.equal(count(56789), '56,789')
  assert.equal(pageLine(1, 8, 1000, 30), 'Page 1 of 1 · 8 total')
  assert.equal(pageLine(2, 1234, 1000, 30), 'Page 2 of 34 · 1,234 total · first 1,000 shown')
  assert.equal(pageLine(1, 5000, null, 30), 'Page 1 of 167 · 5,000 total')
  assert.equal(pageLine(1, 0, null, 30), 'Page 1 of 1 · 0 total')
})

test('reaction tooltips name you first, then the others, then a count', () => {
  const g = (count: number, users: string[], viewerHasReacted = false) => ({ content: 'THUMBS_UP' as const, count, viewerHasReacted, users })
  assert.equal(reactionTip(g(1, ['ana'])), 'ana reacted with 👍')
  assert.equal(reactionTip(g(2, ['ana', 'olu'])), 'ana and olu reacted with 👍')
  assert.equal(reactionTip(g(5, ['chimey', 'ana', 'olu'], true)), 'You, chimey, ana and 2 others reacted with 👍')
  assert.equal(reactionTip(g(1, ['@me'], true)), 'You reacted with 👍')
  assert.equal(reactionTip(g(4, ['ana', 'olu', 'kenji'])), 'ana, olu, kenji and 1 other reacted with 👍')
  // GitHub lists the viewer's own login among the reactors: it reads as You, once.
  assert.equal(reactionTip(g(1, ['thoai'], true), 'thoai'), 'You reacted with 👍')
  assert.equal(reactionTip(g(2, ['thoai', 'ana'], true), 'thoai'), 'You and ana reacted with 👍')
})

test('state events read like GitHub', () => {
  const ev = (kind: 'closed' | 'reopened', reason: 'completed' | 'not_planned' | 'duplicate' | null) => ({ kind, reason, id: 'x', actor: null, createdAt: 0 })
  assert.equal(stateWords(ev('closed', 'completed')).words, 'closed this as completed')
  assert.equal(stateWords(ev('closed', 'not_planned')).words, 'closed this as not planned')
  assert.equal(stateWords(ev('closed', 'duplicate')).words, 'closed this as a duplicate')
  assert.equal(stateWords(ev('reopened', null)).look.tone, 'success')
})
