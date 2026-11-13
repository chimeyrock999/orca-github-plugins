// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

/** Why an answer has no data: finding the focused workspace, asking gh, or reading its answer. */
export type ErrorCode =
  | 'no_workspace'
  | 'workspace_not_found'
  | 'ambiguous_workspace'
  | 'remote_workspace'
  /** An Orca host call failed (workspace.readContext, workspace.list). */
  | 'host_failed'
  | 'not_a_repo'
  | 'gh_missing'
  | 'gh_logged_out'
  /** GitHub has no such repo, issue, run or workflow, or this login cannot see it. */
  | 'not_found'
  | 'rate_limited'
  /** gh did not answer within the worker's limit. */
  | 'timeout'
  /** The panel stopped waiting (closed, or the request timed out). */
  | 'cancelled'
  /** A search the API cannot run, such as plain words in a runs search. */
  | 'bad_query'
  | 'gh_failed'

export type PanelError = {
  code: ErrorCode
  message: string
  /** The workspace folder, once one was found. */
  path?: string
  /** The workspaces that fit the focused context equally well (`ambiguous_workspace`). */
  candidates?: { id: string; name: string; path: string }[]
}

/** Errors are part of the answer: a thrown code that is not a host error code reaches the panel
 *  as `action_failed`, so every request answers `{ ok: false, error }` instead. */
export type Answer<T> = ({ ok: true } & T) | { ok: false; error: PanelError }

/** How the focused workspace was found: its branch and name alone, the person's pick among
 *  workspaces that share them, or one of its terminals. */
export type ResolvedBy = 'context' | 'picked' | 'terminal'

export type RepoAnswer = Answer<{ nameWithOwner: string; url: string; path: string; resolvedBy: ResolvedBy }>

/** A page of a list. `next` is the cursor of the page after it, null on the last page. `limit` is
 *  how many rows GitHub lets anyone page through (its search stops at 1,000 however many match);
 *  null when every row can be reached. */
export type Page<Row> = { rows: Row[]; total: number; next: string | null; limit: number | null }

/** Rows per page: GitHub's own page size. */
export const PAGE_SIZE = 30
/** The most results GitHub's search, and its filtered runs list, return. */
export const SEARCH_LIMIT = 1000

export type IssueState = 'open' | 'done' | 'not_planned'
export type PullState = 'open' | 'draft' | 'merged' | 'closed'
/** `waiting`: a deployment or approval holds it. `skipped`: skipped, neutral or stale. */
export type RunState = 'success' | 'failure' | 'running' | 'waiting' | 'cancelled' | 'skipped'

export type IssueRow = {
  number: number
  title: string
  url: string
  state: IssueState
  author: string | null
  labels: string[]
  /** Milliseconds since the epoch. */
  createdAt: number
  closedAt: number | null
}

export type PullRow = {
  number: number
  title: string
  url: string
  state: PullState
  author: string | null
  labels: string[]
  branch: string
  createdAt: number
  closedAt: number | null
  mergedAt: number | null
}

export type RunRow = {
  id: number
  runNumber: number
  workflow: string
  title: string
  url: string
  state: RunState
  /** What started it: push, pull_request, schedule, workflow_dispatch, ... */
  event: string
  branch: string | null
  sha: string
  actor: string | null
  pullNumber: number | null
  startedAt: number
  /** Finished runs only. */
  durationMs: number | null
}

/** Search orders GitHub offers for issues and pull requests. */
export type ItemSort = 'created-desc' | 'created-asc' | 'updated-desc' | 'comments-desc'
export type ItemFilters = { author?: string; label?: string }

/** Issues and pull requests: `state` picks the list, `open` and `closed` count both. */
export type ItemListInput = {
  state: 'open' | 'closed'
  query: string
  after: string | null
  filters?: ItemFilters
  sort?: ItemSort
  /** Also count open and closed (default true). Paging leaves it off: the counts cannot change. */
  withCounts?: boolean
}
/** `open` and `closed` are null when the counts were not asked for. */
export type ItemPage<Row> = Page<Row> & { open: number | null; closed: number | null }

/** Run filters the runs API takes; `workflow` is a workflow's id, file name or display name. */
export type RunFilters = { workflow?: string; status?: string; event?: string; branch?: string }

/** Runs: `query` takes GitHub's run qualifiers (`branch:`, `status:`, `actor:`, `event:`, `workflow:`);
 *  `filters` win over the same qualifier. The runs API has no order: newest first. */
export type RunListInput = { query: string; after: string | null; filters?: RunFilters }

declare module 'orca' {
  interface PluginRequests {
    /** The GitHub repo (`owner/name`) of the focused workspace. */
    'repo.get': { output: RepoAnswer }
    /** Picks the folder for the focused branch and name when several workspaces share them
     *  (`ambiguous_workspace`); kept in storage and used until it stops matching. */
    'repo.pick': { input: { path: string }; output: RepoAnswer }
    /** Forgets the pick for the focused branch and name. */
    'repo.unpick': { output: RepoAnswer }
    /** One page of the focused repo's issues, newest first. */
    'issues.list': { input: ItemListInput; output: Answer<ItemPage<IssueRow>> }
    /** One page of the focused repo's pull requests, newest first. */
    'pulls.list': { input: ItemListInput; output: Answer<ItemPage<PullRow>> }
    /** One page of the focused repo's workflow runs, newest first. */
    'runs.list': { input: RunListInput; output: Answer<Page<RunRow>> }
    /** The focused repo's label names, for the label filter. */
    'labels.list': { output: Answer<{ names: string[] }> }
    /** The focused repo's workflows, for the workflow filter. */
    'workflows.list': { output: Answer<{ workflows: { id: number; name: string }[] }> }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel when the focused workspace's repo answer changes. */
    'repo.changed': RepoAnswer
  }
}
