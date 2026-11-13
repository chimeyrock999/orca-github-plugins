// One page of the Actions tab's runs, fetched with gh in the repo's folder through the REST runs API,
// which pages by number and has no word search; the repo's labels and workflows; and the states of
// issues and pull requests as GitHub names them. The Issues and Pull requests tabs list no more than
// what Orca links to the workspace (src/worker/linked/linked.ts).
import { GhError, type Gh } from './gh'
import {
  PAGE_SIZE,
  SEARCH_LIMIT,
  type IssueState,
  type PullState,
  type RunListInput,
  type RunPage,
  type RunRow,
  type RunState
} from '../shared/protocol'

/** The repo a request reads or writes, and the workspace folder gh runs in. `other`: not the folder's
 *  own repo (an item Orca links from another one), so gh's issue, pr and label commands name it with
 *  `-R`; the API calls name it anyway. */
export type RepoRef = { nameWithOwner: string; path: string; other?: boolean }

/** `-R owner/name` for gh's repo-picking commands when the repo is not the folder's own. */
export const repoFlag = (repo: RepoRef): string[] => (repo.other ? ['-R', repo.nameWithOwner] : [])

/** An issue's state from GitHub's state and state reason; the linked list and the timeline share it. */
export function issueState(node: { state: string; stateReason?: string | null }): IssueState {
  if (node.state === 'OPEN') return 'open'
  return node.stateReason === 'NOT_PLANNED' || node.stateReason === 'DUPLICATE' ? 'not_planned' : 'done'
}

export function pullState(node: { state: string; isDraft?: boolean; merged?: boolean }): PullState {
  if (node.merged) return 'merged'
  if (node.state === 'CLOSED') return 'closed'
  return node.isDraft ? 'draft' : 'open'
}

/** Run search qualifiers the REST runs API takes as parameters; `workflow:` picks the endpoint. */
const RUN_PARAMS = ['branch', 'status', 'actor', 'event'] as const
export const RUN_QUALIFIERS = [...RUN_PARAMS, 'workflow'] as const

export type RunQuery = { params: Partial<Record<(typeof RUN_PARAMS)[number], string>>; workflow: string | null }

// A qualifier with a bare or "quoted value", or any other word.
const RUN_WORD = /([A-Za-z]+):(?:"([^"]*)"|(\S*))|(\S+)/g

export function parseRunQuery(query: string): RunQuery {
  const parsed: RunQuery = { params: {}, workflow: null }
  for (const [, name, quotedValue, bare] of query.matchAll(RUN_WORD)) {
    const key = name?.toLowerCase() as (typeof RUN_QUALIFIERS)[number] | undefined
    const value = (quotedValue ?? bare ?? '').trim()
    if (!key || !value || !(RUN_QUALIFIERS as readonly string[]).includes(key)) {
      const allowed = RUN_QUALIFIERS.map((q) => `${q}:`).join(' ')
      throw new GhError('bad_query', `GitHub cannot search runs by words. Use ${allowed}`)
    }
    if (key === 'workflow') parsed.workflow = value
    else parsed.params[key] = value
  }
  return parsed
}

export type RunJson = {
  id: number
  name: string | null
  display_title: string
  run_number: number
  event: string
  status: string
  conclusion: string | null
  head_branch: string | null
  head_sha: string
  actor: { login: string } | null
  run_started_at: string | null
  created_at?: string
  updated_at: string
  html_url: string
  pull_requests?: { number: number }[]
}

/** A run's, job's or step's state from GitHub's status and conclusion. */
export function runState(status: string, conclusion: string | null): RunState {
  if (status === 'waiting' || conclusion === 'action_required') return 'waiting'
  if (status === 'queued' || status === 'pending' || status === 'requested') return 'queued'
  if (status !== 'completed') return 'running'
  switch (conclusion) {
    case 'success':
      return 'success'
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failure'
    case 'cancelled':
      return 'cancelled'
    default:
      // skipped, neutral, stale
      return 'skipped'
  }
}

export function runRow(run: RunJson): RunRow {
  const startedAt = Date.parse(run.run_started_at ?? run.created_at ?? run.updated_at)
  return {
    id: run.id,
    runNumber: run.run_number,
    workflow: run.name ?? '',
    title: run.display_title,
    url: run.html_url,
    state: runState(run.status, run.conclusion),
    event: run.event,
    branch: run.head_branch,
    sha: run.head_sha,
    actor: run.actor?.login ?? null,
    // The API also lists pull requests of other repos that share the commit; only trust it for
    // runs a pull request started.
    pullNumber: run.event.startsWith('pull_request') ? (run.pull_requests?.[0]?.number ?? null) : null,
    startedAt,
    durationMs: run.status === 'completed' ? Date.parse(run.updated_at) - startedAt : null
  }
}

/** The repo's label names. */
export async function listLabels(gh: Gh, repo: RepoRef, signal?: AbortSignal): Promise<{ names: string[] }> {
  const out = (await gh(['label', 'list', '--json', 'name', '--limit', '500', ...repoFlag(repo)], { cwd: repo.path, signal, json: true })) as { name: string }[]
  return { names: Array.isArray(out) ? out.map((l) => l.name).sort((a, b) => a.localeCompare(b)) : [] }
}

/** The repo's workflows, every page of them. */
export async function listWorkflows(gh: Gh, repo: RepoRef, signal?: AbortSignal): Promise<{ workflows: { id: number; name: string }[] }> {
  const pages = (await gh(['api', '--paginate', '--slurp', `repos/${repo.nameWithOwner}/actions/workflows?per_page=100`], {
    cwd: repo.path,
    signal,
    json: true
  })) as { workflows?: { id: number; name: string }[] }[]
  const all = Array.isArray(pages) ? pages.flatMap((p) => p?.workflows ?? []) : []
  return { workflows: all.map(({ id, name }) => ({ id, name })) }
}

async function workflowPath(gh: Gh, repo: RepoRef, workflow: string, signal?: AbortSignal): Promise<string> {
  // An id or a file name is what the API takes; a display name (typed in the search) is looked up.
  if (/^\d+$/.test(workflow) || /\.ya?ml$/i.test(workflow)) return encodeURIComponent(workflow)
  const found = (await listWorkflows(gh, repo, signal)).workflows.find((w) => w.name.toLowerCase() === workflow.toLowerCase())
  if (!found) throw new GhError('not_found', `No workflow is named ${workflow}.`)
  return String(found.id)
}

/** One page of runs. `workspaceBranch` is the focused workspace's branch, which `scope: 'branch'`
 *  narrows to when no branch is asked for. */
export async function listRuns(
  gh: Gh,
  repo: RepoRef,
  input: RunListInput,
  signal?: AbortSignal,
  workspaceBranch: string | null = null
): Promise<RunPage> {
  const query = parseRunQuery(input.query)
  const { workflow, ...params } = input.filters ?? {}
  for (const [key, value] of Object.entries(params)) if (value?.trim()) query.params[key as keyof RunQuery['params']] = value.trim()
  const narrowed = input.scope === 'branch' && !query.params.branch && workspaceBranch ? workspaceBranch : null
  if (narrowed) query.params.branch = narrowed
  if (workflow?.trim()) query.workflow = workflow.trim()
  const page = Math.max(1, Number.parseInt(input.after ?? '1', 10) || 1)
  const base = `repos/${repo.nameWithOwner}/actions`
  const path = query.workflow ? `${base}/workflows/${await workflowPath(gh, repo, query.workflow, signal)}/runs` : `${base}/runs`
  // The query goes in the path: a plain GET, which can be a conditional read.
  const search = new URLSearchParams({ per_page: String(PAGE_SIZE), page: String(page), ...query.params })
  const out = (await gh(['api', `${path}?${search}`], { cwd: repo.path, signal, json: true })) as { total_count?: number; workflow_runs?: RunJson[] }
  if (!Array.isArray(out?.workflow_runs) || typeof out.total_count !== 'number') {
    throw new GhError('gh_failed', `Unexpected gh output: ${JSON.stringify(out).slice(0, 200)}`)
  }
  // The runs API stops at 1,000 results once any of these filters is set.
  const limit = Object.keys(query.params).length > 0 ? SEARCH_LIMIT : null
  const reachable = Math.min(out.total_count, limit ?? out.total_count)
  return {
    rows: out.workflow_runs.map(runRow),
    total: out.total_count,
    next: page * PAGE_SIZE < reachable ? String(page + 1) : null,
    limit,
    branch: narrowed
  }
}
