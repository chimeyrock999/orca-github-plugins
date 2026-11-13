// `orca plugin check` renders the panel once per scenario. `requests` stand in for the worker, so
// no scenario reaches the real gh.
import { defineCheck } from 'orca/testing'
import { failed, issueRows, itemPage, pullRows, repoOk, runPage, runRows } from './fixtures'

const lists = {
  'repo.get': repoOk,
  'issues.list': itemPage(issueRows(30), 72, 'p2', 5),
  'pulls.list': itemPage(pullRows, 2, null, 1),
  'runs.list': runPage(runRows, 296, '2')
}
const empty = itemPage([], 0, null)

export default defineCheck({
  issues: { requests: lists },
  'pull-requests': { requests: lists, persisted: { plugin: { tab: 'pulls' } } },
  actions: { requests: lists, persisted: { plugin: { tab: 'runs' } } },
  'empty-repo': { requests: { 'repo.get': repoOk, 'issues.list': empty, 'pulls.list': empty, 'runs.list': empty } },
  'no-workspace': { requests: { 'repo.get': failed('no_workspace', 'No workspace is focused in Orca.') } },
  'not-a-github-repo': {
    requests: { 'repo.get': failed('not_a_repo', 'none of the git remotes configured for this repository point to a known GitHub host') }
  },
  'gh-logged-out': { requests: { 'repo.get': failed('gh_logged_out', 'To get started with GitHub CLI, please run:  gh auth login') } },
  'rate-limited': { requests: { ...lists, 'issues.list': failed('rate_limited', 'API rate limit exceeded for user ID 1.') } }
})
