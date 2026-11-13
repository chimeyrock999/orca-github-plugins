// One page of each tab's list, fetched with gh in the repo's folder. Issues and pull requests go
// through GitHub's search, which pages by cursor and counts open and closed in the same call;
// runs go through the REST runs API, which pages by number and has no word search.
import { GhError, type Gh } from './gh'
import {
  PAGE_SIZE,
  SEARCH_LIMIT,
  type IssueRow,
  type IssueState,
  type ItemFilters,
  type ItemListInput,
  type ItemPage,
  type ItemSort,
  type Page,
  type PullRow,
  type PullState,
  type RunListInput,
  type RunRow,
  type RunState
} from './protocol'

export type RepoRef = { nameWithOwner: string; path: string }

/** A qualifier value in quotes when it has spaces, as GitHub's search wants: label:"good first issue". */
function quoted(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, '')}"` : value
}

function filterWords(filters: ItemFilters = {}): string[] {
  const words: string[] = []
  if (filters.author?.trim()) words.push(`author:${quoted(filters.author.trim())}`)
  if (filters.label?.trim()) words.push(`label:${quoted(filters.label.trim())}`)
  if (filters.assignee?.trim()) words.push(`assignee:${quoted(filters.assignee.trim())}`)
  return words
}

/** The search for the repo's issues or pull requests in one state (`all`: either): qualifiers, the
 *  order when the rows are wanted (counts need none), then the words. Rows and counts share it, so
 *  they agree. */
export function itemSearch(
  repo: RepoRef,
  kind: 'issue' | 'pr',
  state: 'open' | 'closed' | 'all',
  words: string,
  filters?: ItemFilters,
  sort: ItemSort | null = 'created-desc'
): string {
  const order = sort ? [`sort:${sort}`] : []
  const states = state === 'all' ? [] : [`is:${state}`]
  return [`repo:${repo.nameWithOwner}`, `is:${kind}`, ...states, ...filterWords(filters), ...order, words.trim()]
    .filter(Boolean)
    .join(' ')
}

const ITEM_FIELDS = `number title url state createdAt closedAt author { login } labels(first: 10) { nodes { name } }`

const ITEM_QUERY = `query($q: String!, $openQ: String!, $closedQ: String!, $first: Int!, $after: String, $withCounts: Boolean!) {
  page: search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on Issue { ${ITEM_FIELDS} stateReason }
      ... on PullRequest { ${ITEM_FIELDS} isDraft merged mergedAt headRefName }
    }
  }
  open: search(query: $openQ, type: ISSUE, first: 0) @include(if: $withCounts) { issueCount }
  closed: search(query: $closedQ, type: ISSUE, first: 0) @include(if: $withCounts) { issueCount }
}`

type ItemNode = {
  __typename: string
  number: number
  title: string
  url: string
  state: string
  createdAt: string
  closedAt: string | null
  author: { login: string } | null
  labels?: { nodes: { name: string }[] }
  stateReason?: string | null
  isDraft?: boolean
  merged?: boolean
  mergedAt?: string | null
  headRefName?: string
}

type SearchData = {
  page: { issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ItemNode[] }
  open?: { issueCount: number }
  closed?: { issueCount: number }
}

function time(value: string | null | undefined): number | null {
  return value ? Date.parse(value) : null
}

async function searchItems(
  gh: Gh,
  repo: RepoRef,
  kind: 'issue' | 'pr',
  input: ItemListInput,
  signal?: AbortSignal
): Promise<{ data: SearchData; nodes: ItemNode[] }> {
  const args = [
    'api',
    'graphql',
    '-f',
    `query=${ITEM_QUERY}`,
    '-f',
    `q=${itemSearch(repo, kind, input.state, input.query, input.filters, input.sort)}`,
    '-f',
    `openQ=${itemSearch(repo, kind, 'open', input.query, input.filters, null)}`,
    '-f',
    `closedQ=${itemSearch(repo, kind, 'closed', input.query, input.filters, null)}`,
    '-F',
    `first=${PAGE_SIZE}`,
    '-F',
    `withCounts=${input.withCounts !== false}`
  ]
  if (input.after) args.push('-f', `after=${input.after}`)
  const out = (await gh(args, { cwd: repo.path, signal, json: true })) as { data?: SearchData; errors?: { message: string }[] }
  if (!out?.data?.page) {
    const why = out?.errors?.map((e) => e.message).join('; ') || 'no data'
    throw new GhError('gh_failed', `GitHub search failed: ${why}`)
  }
  const type = kind === 'issue' ? 'Issue' : 'PullRequest'
  return { data: out.data, nodes: out.data.page.nodes.filter((n) => n.__typename === type) }
}

function itemPage<Row>(data: SearchData, rows: Row[]): ItemPage<Row> {
  const { issueCount, pageInfo } = data.page
  return {
    rows,
    total: issueCount,
    open: data.open?.issueCount ?? null,
    closed: data.closed?.issueCount ?? null,
    next: pageInfo.hasNextPage ? pageInfo.endCursor : null,
    limit: SEARCH_LIMIT
  }
}

/** An issue's state from GitHub's state and state reason; the list and the timeline share it. */
export function issueState(node: { state: string; stateReason?: string | null }): IssueState {
  if (node.state === 'OPEN') return 'open'
  return node.stateReason === 'NOT_PLANNED' || node.stateReason === 'DUPLICATE' ? 'not_planned' : 'done'
}

export function pullState(node: { state: string; isDraft?: boolean; merged?: boolean }): PullState {
  if (node.merged) return 'merged'
  if (node.state === 'CLOSED') return 'closed'
  return node.isDraft ? 'draft' : 'open'
}

function itemFields(node: ItemNode) {
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    author: node.author?.login ?? null,
    labels: node.labels?.nodes.map((l) => l.name) ?? [],
    createdAt: Date.parse(node.createdAt),
    closedAt: time(node.closedAt)
  }
}

export async function listIssues(gh: Gh, repo: RepoRef, input: ItemListInput, signal?: AbortSignal): Promise<ItemPage<IssueRow>> {
  const { data, nodes } = await searchItems(gh, repo, 'issue', input, signal)
  return itemPage(data, nodes.map((n): IssueRow => ({ ...itemFields(n), state: issueState(n) })))
}

export async function listPulls(gh: Gh, repo: RepoRef, input: ItemListInput, signal?: AbortSignal): Promise<ItemPage<PullRow>> {
  const { data, nodes } = await searchItems(gh, repo, 'pr', input, signal)
  return itemPage(
    data,
    nodes.map((n): PullRow => ({ ...itemFields(n), state: pullState(n), branch: n.headRefName ?? '', mergedAt: time(n.mergedAt) }))
  )
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

type RunJson = {
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

function runState(run: RunJson): RunState {
  if (run.status === 'waiting' || run.conclusion === 'action_required') return 'waiting'
  if (run.status !== 'completed') return 'running'
  switch (run.conclusion) {
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

function runRow(run: RunJson): RunRow {
  const startedAt = Date.parse(run.run_started_at ?? run.created_at ?? run.updated_at)
  return {
    id: run.id,
    runNumber: run.run_number,
    workflow: run.name ?? '',
    title: run.display_title,
    url: run.html_url,
    state: runState(run),
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
  const out = (await gh(['label', 'list', '--json', 'name', '--limit', '500'], { cwd: repo.path, signal, json: true })) as { name: string }[]
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

export async function listRuns(gh: Gh, repo: RepoRef, input: RunListInput, signal?: AbortSignal): Promise<Page<RunRow>> {
  const query = parseRunQuery(input.query)
  const { workflow, ...params } = input.filters ?? {}
  for (const [key, value] of Object.entries(params)) if (value?.trim()) query.params[key as keyof RunQuery['params']] = value.trim()
  if (workflow?.trim()) query.workflow = workflow.trim()
  const page = Math.max(1, Number.parseInt(input.after ?? '1', 10) || 1)
  const base = `repos/${repo.nameWithOwner}/actions`
  const path = query.workflow ? `${base}/workflows/${await workflowPath(gh, repo, query.workflow, signal)}/runs` : `${base}/runs`
  const args = ['api', '-X', 'GET', path, '-F', `per_page=${PAGE_SIZE}`, '-F', `page=${page}`]
  for (const [key, value] of Object.entries(query.params)) args.push('-f', `${key}=${value}`)
  const out = (await gh(args, { cwd: repo.path, signal, json: true })) as { total_count?: number; workflow_runs?: RunJson[] }
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
    limit
  }
}
