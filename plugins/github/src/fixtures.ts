// Sample answers the panel tests and check scenarios stand in for the worker with.
import type { Answer, IssueRow, ItemPage, Page, PullRow, RepoAnswer, RunRow } from './protocol'

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

export const pullRows: PullRow[] = [
  { number: 124, title: 'Fix token refresh loop', url: 'https://github.com/octo/app/pull/124', state: 'open', author: 'mai-t', labels: ['bug'], branch: 'fix/token-refresh', createdAt: now - hour, closedAt: null, mergedAt: null },
  { number: 123, title: 'Stream CSV export', url: 'https://github.com/octo/app/pull/123', state: 'draft', author: 'ana', labels: [], branch: 'feature/stream-csv', createdAt: now - 20 * hour, closedAt: null, mergedAt: null }
]

export const runRows: RunRow[] = [
  { id: 9001, runNumber: 296, workflow: 'CI', title: 'Fix token refresh loop', url: 'https://github.com/octo/app/actions/runs/9001', state: 'running', event: 'pull_request', branch: 'fix/token-refresh', sha: 'e057cbe1d2', actor: 'mai-t', pullNumber: 124, startedAt: now - 120_000, durationMs: null },
  { id: 9000, runNumber: 295, workflow: 'CI', title: 'Merge pull request #121 from octo/docs', url: 'https://github.com/octo/app/actions/runs/9000', state: 'success', event: 'push', branch: 'main', sha: '40378fb9a1', actor: 'kenji', pullNumber: null, startedAt: now - 3 * hour, durationMs: 466_000 },
  { id: 8999, runNumber: 41, workflow: 'Release', title: 'Release 1.8.0', url: 'https://github.com/octo/app/actions/runs/8999', state: 'failure', event: 'workflow_dispatch', branch: 'main', sha: 'ac11ec5f00', actor: 'olu', pullNumber: null, startedAt: now - 30 * hour, durationMs: 57_000 }
]

export function itemPage<Row>(rows: Row[], total: number, next: string | null, closed = 0): Answer<ItemPage<Row>> {
  return { ok: true, rows, total, open: total, closed, next, limit: 1000 }
}

export function runPage(rows: RunRow[], total = rows.length, next: string | null = null, limit: number | null = null): Answer<Page<RunRow>> {
  return { ok: true, rows, total, next, limit }
}
