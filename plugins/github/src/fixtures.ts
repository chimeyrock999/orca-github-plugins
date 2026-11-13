// Sample answers the panel tests and check scenarios stand in for the worker with.
import type {
  Answer,
  CheckCounts,
  DispatchForm,
  IssueDetail,
  IssueRow,
  ItemPage,
  PullDetail,
  RepoAnswer,
  RunDetail,
  RunJob,
  RunLogs,
  RunPage,
  RunRow,
  RunStep,
  TimelineComment,
  TimelineItem,
  TimelineReview
} from './protocol'

const now = Date.UTC(2026, 10, 12, 9, 0)
const hour = 3_600_000

export const repoOk: Extract<RepoAnswer, { ok: true }> = {
  ok: true,
  nameWithOwner: 'octo/app',
  url: 'https://github.com/octo/app',
  path: '/code/app',
  resolvedBy: 'context'
}

export function failed(code: Extract<RepoAnswer, { ok: false }>['error']['code'], message: string): { ok: false; error: { code: typeof code; message: string } } {
  return { ok: false, error: { code, message } }
}

const titles = [
  'Login page loops after token refresh',
  'Dark theme: table header has no contrast',
  'Export CSV drops rows past 10k',
  'Docs: explain workspace settings',
  'Crash when the config file is empty'
]

export function issueRows(count: number, first = 120): IssueRow[] {
  return Array.from({ length: count }, (_, i) => ({
    number: first - i,
    title: titles[i % titles.length],
    url: `https://github.com/octo/app/issues/${first - i}`,
    state: 'open',
    author: ['mai-t', 'kenji', 'ana'][i % 3],
    labels: i % 2 ? ['bug'] : [],
    createdAt: now - (i + 1) * hour,
    closedAt: null
  }))
}

export const runRows: RunRow[] = [
  { id: 9001, runNumber: 296, workflow: 'CI', title: 'Fix token refresh loop', url: 'https://github.com/octo/app/actions/runs/9001', state: 'running', event: 'pull_request', branch: 'fix/token-refresh', sha: 'e057cbe1d2', actor: 'mai-t', pullNumber: 124, startedAt: now - 120_000, durationMs: null },
  { id: 9000, runNumber: 295, workflow: 'CI', title: 'Merge pull request #121 from octo/docs', url: 'https://github.com/octo/app/actions/runs/9000', state: 'success', event: 'push', branch: 'main', sha: '40378fb9a1', actor: 'kenji', pullNumber: null, startedAt: now - 3 * hour, durationMs: 466_000 },
  { id: 8999, runNumber: 41, workflow: 'Release', title: 'Release 1.8.0', url: 'https://github.com/octo/app/actions/runs/8999', state: 'failure', event: 'workflow_dispatch', branch: 'main', sha: 'ac11ec5f00', actor: 'olu', pullNumber: null, startedAt: now - 30 * hour, durationMs: 57_000 }
]

export function itemPage<Row>(rows: Row[], total: number, next: string | null, closed = 0): Answer<ItemPage<Row>> {
  return { ok: true, rows, total, open: total, closed, next, limit: 1000 }
}

export function runPage(
  rows: RunRow[],
  total = rows.length,
  next: string | null = null,
  limit: number | null = null,
  branch: string | null = null
): Answer<RunPage> {
  return { ok: true, rows, total, next, limit, branch }
}

export function commentItem(n: number, change: Partial<TimelineComment> = {}): TimelineComment {
  return {
    kind: 'comment',
    id: `IC_${n}`,
    databaseId: 1000 + n,
    url: `https://github.com/octo/app/issues/120#issuecomment-${1000 + n}`,
    author: 'kenji',
    body: `Comment ${n}`,
    truncated: false,
    createdAt: now - (40 - n) * hour,
    edited: false,
    canEdit: false,
    canDelete: false,
    reactions: [],
    ...change
  }
}

export const timeline: TimelineItem[] = [
  commentItem(1, { body: 'Reproduced on 1.8.0. Same as #97.', reactions: [{ content: 'HOORAY', count: 1, viewerHasReacted: false, users: ['mai-t'] }] }),
  {
    kind: 'mention',
    id: 'CRE_1',
    actor: 'chimeyrock999',
    createdAt: now - 30 * hour,
    source: { type: 'pull', number: 131, title: 'fix: stream CSV export past 10k rows', url: 'https://github.com/octo/app/pull/131', state: 'open', repo: 'octo/app' }
  },
  commentItem(2, { author: 'chimeyrock999', body: 'Working on it in #131.', edited: true, canEdit: true, canDelete: true }),
  {
    kind: 'mention',
    id: 'CRE_2',
    actor: 'lucia',
    createdAt: now - 20 * hour,
    source: { type: 'issue', number: 97, title: 'Excel export truncates long cells', url: 'https://github.com/octo/app/issues/97', state: 'done', repo: 'octo/app' }
  },
  {
    kind: 'mention',
    id: 'CRE_3',
    actor: 'olu',
    createdAt: now - 10 * hour,
    source: { type: 'pull', number: 412, title: 'docs: note the 10k export limit', url: 'https://github.com/octo/docs/pull/412', state: 'merged', repo: 'octo/docs' }
  }
]

export function issueDetail(change: Partial<IssueDetail> = {}): IssueDetail {
  return {
    id: 'I_120',
    number: 120,
    title: 'Export CSV drops rows past 10k',
    url: 'https://github.com/octo/app/issues/120',
    state: 'open',
    author: 'mai-t',
    body: 'Exporting a table with more than 10,000 rows writes only the first 10,000.\n\n![shot](https://user-images.githubusercontent.com/1.png)',
    truncated: false,
    createdAt: now - 76 * hour,
    closedAt: null,
    labels: ['bug', 'export'],
    assignees: ['chimeyrock999'],
    milestone: 'v1.9',
    canEdit: true,
    reactions: [{ content: 'THUMBS_UP', count: 2, viewerHasReacted: true, users: ['chimeyrock999', 'ana'] }],
    comments: 2,
    total: timeline.length,
    head: timeline,
    next: null,
    tail: [],
    viewer: 'chimeyrock999',
    ...change
  }
}

const minute = 60_000

/** Run 9001 of runRows in full: two jobs done, the test job failed in its Test step. */
export function runDetail(change: Partial<RunDetail> = {}): RunDetail {
  const steps = (failed: boolean): RunStep[] => [
    { number: 1, name: 'Set up job', state: 'success', durationMs: 2_000 },
    { number: 2, name: 'Install', state: 'success', durationMs: 38_000 },
    { number: 3, name: 'Test', state: failed ? 'failure' : 'success', durationMs: 112_000 }
  ]
  const job = (id: number, name: string, failed: boolean): RunJob => ({
    id,
    name,
    url: `https://github.com/octo/app/actions/runs/9001/job/${id}`,
    state: failed ? 'failure' : 'success',
    startedAt: now - 5 * minute,
    durationMs: 167_000,
    steps: steps(failed)
  })
  return {
    ...runRows[0],
    state: 'failure',
    durationMs: 6 * minute,
    attempt: 1,
    workflowId: 77,
    done: true,
    jobs: [job(501, 'lint', false), job(502, 'test (ubuntu-latest)', true)],
    waitingFor: [],
    ...change
  }
}

/** The same run still going: lint done, the test job in its Test step. */
export function runningRun(): RunDetail {
  const run = runDetail({ state: 'running', durationMs: null, done: false })
  const test = run.jobs[1]
  return {
    ...run,
    jobs: [
      run.jobs[0],
      { ...test, state: 'running', durationMs: null, steps: test.steps.map((s) => (s.name === 'Test' ? { ...s, state: 'running', durationMs: null } : s)) }
    ]
  }
}

export function failedLogs(dropped = 0): RunLogs {
  return {
    url: 'https://github.com/octo/app/actions/runs/9001',
    skippedJobs: 0,
    unread: [],
    steps: [
      {
        job: 'test (ubuntu-latest)',
        jobId: 502,
        step: 'Test',
        failed: true,
        dropped,
        lines: [' ✓ src/export/header.test.ts (4 tests)', ' ✕ src/export/stream.test.ts > writes 25k rows', '   AssertionError: expected 24999 to be 25000', '##[error]Process completed with exit code 1.']
      }
    ]
  }
}

export const workflows = [
  { id: 77, name: 'CI' },
  { id: 78, name: 'Release' }
]

export const releaseForm: DispatchForm = {
  ref: 'fix/token-refresh',
  dispatch: true,
  inputs: [
    { name: 'version', type: 'string', description: 'Version to tag, such as 1.9.1', required: true, default: null, options: [] },
    { name: 'channel', type: 'choice', description: 'Where to publish', required: true, default: 'beta', options: ['stable', 'beta'] },
    { name: 'dry_run', type: 'boolean', description: 'Build without publishing', required: false, default: true, options: [] }
  ]
}

export function reviewItem(n: number, change: Partial<TimelineReview> = {}): TimelineReview {
  return {
    kind: 'review',
    id: `PRR_${n}`,
    url: `https://github.com/octo/app/pull/131#pullrequestreview-${5000 + n}`,
    author: 'ana',
    state: 'commented',
    body: `Review ${n}`,
    truncated: false,
    createdAt: now - (30 - n) * hour,
    comments: 0,
    reactions: [],
    ...change
  }
}

export const checkCounts: CheckCounts = { passed: 4, failed: 1, cancelled: 0, needsAction: 0, pending: 1, neutral: 0 }

export const pullTimelineItems: TimelineItem[] = [
  commentItem(1, { body: 'Does this keep the header row when the first page is empty?', url: 'https://github.com/octo/app/pull/131#issuecomment-1001' }),
  reviewItem(2, { author: 'lucia', body: 'Looks right. Two nits inline.', comments: 2 }),
  reviewItem(3, { state: 'changes_requested', body: 'The writer is never closed when the request fails.', comments: 1 }),
  reviewItem(4, { state: 'approved', author: 'olu', body: '' }),
  commentItem(5, { author: 'chimeyrock999', body: 'Fixed in the last push.', canEdit: true, canDelete: true })
]

export function pullDetail(change: Partial<PullDetail> = {}): PullDetail {
  return {
    id: 'PR_131',
    number: 131,
    title: 'fix: stream CSV export past 10k rows',
    url: 'https://github.com/octo/app/pull/131',
    state: 'open',
    author: 'kenji',
    body: 'Streams the rows to the CSV writer. Closes #120.',
    truncated: false,
    createdAt: now - 52 * hour,
    closedAt: null,
    mergedAt: null,
    labels: ['bug', 'export'],
    assignees: ['kenji'],
    milestone: 'v1.9',
    canEdit: true,
    reactions: [{ content: 'ROCKET', count: 2, viewerHasReacted: false, users: ['ana', 'olu'] }],
    comments: 2,
    total: pullTimelineItems.length,
    head: pullTimelineItems,
    next: null,
    tail: [],
    viewer: 'chimeyrock999',
    baseRef: 'dev',
    headRef: 'kenji:stream-export',
    merge: 'unstable',
    review: 'changes_requested',
    reviewers: ['ana'],
    checks: checkCounts,
    ...change
  }
}
