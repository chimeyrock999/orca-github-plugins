// `orca plugin check` renders the panel once per scenario. `requests` stand in for the worker, so
// no scenario reaches the real gh.
import { defineCheck } from 'orca/testing'
import { commentItem, failed, issueDetail, issueRows, itemPage, pullRows, repoOk, runPage, runRows } from './fixtures'

const lists = {
  'repo.get': repoOk,
  'issues.list': itemPage(issueRows(30), 72, 'p2', 5),
  'pulls.list': itemPage(pullRows, 2, null, 1),
  'runs.list': runPage(runRows, 296, '2')
}
const empty = itemPage([], 0, null)
// An issue left open by an earlier run opens again, which is how these scenarios show one.
const openIssue = { workspace: { openIssue: { repo: 'octo/app', path: '/code/app', number: 120 } } }
const longTimeline = issueDetail({
  head: Array.from({ length: 3 }, (_, i) => commentItem(i + 1)),
  tail: [commentItem(40, { body: 'Shipped in 1.9.', reactions: [{ content: 'ROCKET', count: 3, viewerHasReacted: true, users: ['ana', 'olu'] }] })],
  next: 'c3',
  total: 41,
  comments: 38
})

export default defineCheck({
  issues: { requests: lists },
  'issue-detail': { requests: { ...lists, 'issue.get': { ok: true, issue: issueDetail() } }, persisted: openIssue },
  'issue-closed': {
    requests: {
      ...lists,
      'issue.get': {
        ok: true,
        issue: issueDetail({
          state: 'not_planned',
          closedAt: Date.UTC(2026, 10, 12, 8, 0),
          head: [...issueDetail().head, { kind: 'closed', id: 'CE_1', actor: 'mai-t', createdAt: Date.UTC(2026, 10, 12, 8, 0), reason: 'not_planned' }]
        })
      }
    },
    persisted: openIssue
  },
  'issue-long-timeline': { requests: { ...lists, 'issue.get': { ok: true, issue: longTimeline } }, persisted: openIssue },
  'issue-read-only': { requests: { ...lists, 'issue.get': { ok: true, issue: issueDetail({ canEdit: false }) } }, persisted: openIssue },
  'issue-not-found': { requests: { ...lists, 'issue.get': failed('not_found', 'Could not resolve to an Issue with the number of 120.') }, persisted: openIssue },
  'pull-requests': { requests: lists, persisted: { plugin: { tab: 'pulls' } } },
  actions: { requests: lists, persisted: { plugin: { tab: 'runs' } } },
  'empty-repo': { requests: { 'repo.get': repoOk, 'issues.list': empty, 'pulls.list': empty, 'runs.list': empty } },
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
            { id: 'w-app', name: 'main', path: '/code/app' },
            { id: 'w-lib', name: 'main', path: '/code/lib' },
            { id: 'w-docs', name: 'main', path: '/code/docs' }
          ]
        }
      }
    }
  },
  'gh-logged-out': { requests: { 'repo.get': failed('gh_logged_out', 'To get started with GitHub CLI, please run:  gh auth login') } },
  'rate-limited': { requests: { ...lists, 'issues.list': failed('rate_limited', 'API rate limit exceeded for user ID 1.') } }
})
