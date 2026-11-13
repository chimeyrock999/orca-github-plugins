// `orca plugin check` renders the panel once per scenario. `requests` stand in for the worker, so
// no scenario reaches the real gh.
import { defineCheck } from 'orca/testing'
import type { Answer, PullDetail } from './shared/protocol'
import { commentItem, failed, issueDetail, links, linkedRows, pullDetail, ref, repoOk, runPage, runRows } from '../tests/fixtures/fixtures'

const lists = {
  'repo.get': repoOk,
  'repo.links': links(),
  'agent.find': { ok: true as const, agent: { name: 'Claude Code', terminalId: 't1' } },
  // The Actions tab starts on the workspace's branch.
  'runs.list': runPage(runRows, 296, '2', 1000, 'fix/token-refresh')
}
// A workspace linked to issue 120 alone opens on it, which is how these scenarios show an issue.
const linked = { 'repo.links': links([120]) }
// The workspace's only pull request (here 131) opens in the Pull requests tab.
const linkedPull = { 'repo.links': links([], [131]) }
// Several linked items, one of another repo: a short list.
const several = [ref(120), ref('octo/sdk#45'), ref(98)]
const onPulls = { persisted: { plugin: { tab: 'pulls' } } }
const mergedAt = Date.UTC(2026, 10, 12, 8, 0)
const pullScenario = (answer: Answer<{ pull: PullDetail }>) => ({ requests: { ...lists, ...linkedPull, 'pull.get': answer }, ...onPulls })
const showPull = (change: Partial<PullDetail> = {}) => pullScenario({ ok: true, pull: pullDetail(change) })
const longTimeline = issueDetail({
  head: Array.from({ length: 3 }, (_, i) => commentItem(i + 1)),
  tail: [commentItem(40, { body: 'Shipped in 1.9.', reactions: [{ content: 'ROCKET', count: 3, viewerHasReacted: true, users: ['ana', 'olu'] }] })],
  next: 'c3',
  total: 41,
  comments: 38
})

export default defineCheck({
  issues: { requests: lists },
  'issues-no-agent': { requests: { ...lists, 'agent.find': { ok: true, agent: null } } },
  'issues-several': { requests: { ...lists, 'repo.links': links([120, 'octo/sdk#45', 98]), 'items.get': linkedRows(several) } },
  // The GitHub budget shared with Orca is low: the panel says so above the tabs.
  'budget-low': {
    requests: {
      ...lists,
      'repo.links': links([120, 'octo/sdk#45', 98]),
      'items.get': linkedRows(several),
      'budget.get': { ok: true, budget: { limit: 5000, remaining: 312, resetAt: Date.UTC(2026, 10, 13, 14, 5) } }
    }
  },
  'issues-several-failed': {
    requests: { ...lists, 'repo.links': links([120, 98]), 'items.get': failed('rate_limited', 'API rate limit exceeded for user ID 1.') }
  },
  'issue-detail': { requests: { ...lists, ...linked, 'issue.get': { ok: true, issue: issueDetail() } } },
  'issue-closed': {
    requests: {
      ...lists,
      ...linked,
      'issue.get': {
        ok: true,
        issue: issueDetail({
          state: 'not_planned',
          closedAt: Date.UTC(2026, 10, 12, 8, 0),
          head: [...issueDetail().head, { kind: 'closed', id: 'CE_1', actor: 'mai-t', createdAt: Date.UTC(2026, 10, 12, 8, 0), reason: 'not_planned' }]
        })
      }
    }
  },
  'issue-long-timeline': { requests: { ...lists, ...linked, 'issue.get': { ok: true, issue: longTimeline } } },
  'issue-read-only': { requests: { ...lists, ...linked, 'issue.get': { ok: true, issue: issueDetail({ canEdit: false }) } } },
  'issue-not-found': { requests: { ...lists, ...linked, 'issue.get': failed('not_found', 'Could not resolve to an Issue with the number of 120.') } },
  'pull-none': { requests: lists, ...onPulls },
  'pulls-several': { requests: { ...lists, 'repo.links': links([], [131, 129]), 'items.get': linkedRows([ref(131), ref(129)], 'pulls') }, ...onPulls },
  'pull-detail': showPull(),
  'pull-own': showPull({ author: 'chimeyrock999', review: 'review_required', reviewers: ['ana', 'core'] }),
  'pull-ready': showPull({ merge: 'clean', review: 'approved', reviewers: [], checks: { passed: 5, failed: 0, cancelled: 0, needsAction: 0, pending: 0, neutral: 0 } }),
  'pull-conflicts': showPull({ merge: 'conflicts' }),
  'pull-draft': showPull({ state: 'draft', merge: 'draft', review: null, checks: null, head: [], total: 0, comments: 0 }),
  'pull-closed': showPull({
    state: 'closed',
    closedAt: mergedAt,
    head: [...pullDetail().head, { kind: 'closed', id: 'CE_1', actor: 'kenji', createdAt: mergedAt, reason: null }]
  }),
  'pull-merged': showPull({
    state: 'merged',
    merge: 'unknown',
    review: 'approved',
    mergedAt,
    closedAt: mergedAt,
    head: [...pullDetail().head, { kind: 'merged', id: 'ME_1', actor: 'ana', createdAt: mergedAt, commit: 'a1935b0', into: 'dev' }]
  }),
  'pull-not-found': pullScenario(failed('not_found', 'Could not resolve to a PullRequest with the number of 131.')),
  actions: { requests: lists, persisted: { plugin: { tab: 'runs' } } },
  // Scenarios cannot press, so a run's detail and the Run workflow form are covered by
  // tests/panel/runs/run-view.test.tsx; this one shows the list with a run waiting to start.
  'actions-queued': {
    requests: { ...lists, 'runs.list': runPage([{ ...runRows[0], id: 9002, runNumber: 297, state: 'queued', startedAt: runRows[0].startedAt + 60_000 }, ...runRows], 297, '2') },
    persisted: { plugin: { tab: 'runs' } }
  },
  'empty-repo': { requests: { ...lists, 'runs.list': runPage([]) }, persisted: { plugin: { tab: 'runs' } } },
  'no-workspace': { requests: { 'repo.get': failed('no_workspace', 'No workspace is focused in Orca.') } },
  'not-a-github-repo': {
    requests: { 'repo.get': failed('not_a_repo', 'none of the git remotes configured for this repository point to a known GitHub host') }
  },
  'ambiguous-workspace': {
    requests: {
      'repo.get': {
        ok: false,
        error: {
          code: 'ambiguous_workspace',
          message: '3 workspaces are on main and named main.',
          candidates: [
            { id: 'w-app', name: 'main', path: '/code/app', project: 'app', branch: 'main' },
            { id: 'w-lib', name: 'main', path: '/code/lib', project: 'lib', branch: 'main' },
            { id: 'w-docs', name: 'main', path: '/code/docs', project: null, branch: 'main' }
          ]
        }
      }
    }
  },
  'gh-logged-out': { requests: { 'repo.get': failed('gh_logged_out', 'To get started with GitHub CLI, please run:  gh auth login') } },
  'rate-limited': { requests: { ...lists, 'runs.list': failed('rate_limited', 'API rate limit exceeded for user ID 1.') }, persisted: { plugin: { tab: 'runs' } } }
})
