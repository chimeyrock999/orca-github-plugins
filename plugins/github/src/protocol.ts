// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

/** Why an answer has no data: finding the focused workspace, asking gh, or reading its answer. */
export type ErrorCode =
  | 'no_workspace'
  | 'workspace_not_found'
  | 'ambiguous_workspace'
  | 'remote_workspace'
  /** An Orca host call failed (workspace.readContext, workspace.list), or a panel request was
   *  rejected without a code. */
  | 'host_failed'
  /** Panel only: the worker threw something that is not a gh failure, or Orca refused the request
   *  as malformed. A bug in the plugin. */
  | 'action_failed'
  /** Panel only: the answer is bigger than Orca passes to a panel. */
  | 'too_large'
  /** Panel only: Orca could not reach the plugin's worker. */
  | 'unavailable'
  | 'not_a_repo'
  | 'gh_missing'
  | 'gh_logged_out'
  /** GitHub has no such repo, issue, run or workflow, or this login cannot see it. */
  | 'not_found'
  /** GitHub's rate limit, or Orca's own pace for panel requests (then with `retryAfterMs`). */
  | 'rate_limited'
  /** gh did not answer within the worker's limit. */
  | 'timeout'
  /** The panel stopped waiting (closed, or the request timed out). */
  | 'cancelled'
  /** A search the API cannot run, such as plain words in a runs search. */
  | 'bad_query'
  | 'gh_failed'
  /** Panel only: a write got no answer in time, so it may or may not have landed. */
  | 'unsure'

export type PanelError = {
  code: ErrorCode
  message: string
  /** The workspace folder, once one was found. */
  path?: string
  /** The workspaces that fit the focused context equally well (`ambiguous_workspace`). */
  candidates?: { id: string; name: string; path: string }[]
  /** How long Orca asks the panel to wait (`rate_limited` from Orca). */
  retryAfterMs?: number
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
/** `queued`: not started yet. `waiting`: a deployment or approval holds it. `skipped`: skipped,
 *  neutral or stale. Runs, jobs and steps share it. */
export type RunState = 'success' | 'failure' | 'running' | 'queued' | 'waiting' | 'cancelled' | 'skipped'

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
export type ItemFilters = { author?: string; label?: string; assignee?: string }

/** Issues and pull requests: `state` picks the list (`all` is both), `open` and `closed` count both. */
export type ItemListInput = {
  state: 'open' | 'closed' | 'all'
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
 *  `filters` win over the same qualifier. The runs API has no order: newest first. `scope: 'branch'`
 *  lists the runs of the focused workspace's branch unless a branch is asked for already. */
export type RunListInput = { query: string; after: string | null; filters?: RunFilters; scope?: 'branch' | 'all' }
/** `branch`: the workspace branch the page was narrowed to by `scope`, else null. */
export type RunPage = Page<RunRow> & { branch: string | null }

export type RunStep = {
  number: number
  name: string
  state: RunState
  /** Finished steps only. */
  durationMs: number | null
}

export type RunJob = {
  id: number
  name: string
  url: string
  state: RunState
  startedAt: number | null
  /** Finished jobs only. */
  durationMs: number | null
  steps: RunStep[]
  /** The steps were left out so a big run fits one panel message. */
  stepsCut?: boolean
}

/** One run with the jobs of its latest attempt. `done` once it is completed: nothing changes after.
 *  `waitingFor`: the environments a waiting run needs a deployment approval for. */
export type RunDetail = RunRow & { attempt: number; workflowId: number; done: boolean; jobs: RunJob[]; waitingFor: string[] }

/** One step's log: its last lines, `dropped` the lines cut before them. */
export type LogStep = {
  job: string
  /** The job's id, when the log was asked for by job. */
  jobId: number | null
  step: string
  lines: string[]
  dropped: number
  /** The step failed (a failed-steps log has only those). */
  failed: boolean
}
/** A run's failed steps, or one job's whole log. `url` is where the full log is on GitHub;
 *  `skippedJobs` how many failed jobs were not read (a failed-steps log reads a few jobs only);
 *  `unread` the failed jobs whose log gh could not read, and why. */
export type RunLogs = { steps: LogStep[]; url: string; skippedJobs: number; unread: { job: string; message: string }[] }

/** One `workflow_dispatch` input as the workflow file declares it. */
export type DispatchInput = {
  name: string
  type: 'string' | 'boolean' | 'choice' | 'number' | 'environment'
  description: string | null
  required: boolean
  default: string | boolean | null
  /** A choice's options, or the repo's environments for an `environment` input. */
  options: string[]
}
/** What the Run workflow form needs: the ref the file was read from, whether the workflow can be run
 *  by hand, and its inputs (null when the file could not be read: name and value fields instead). */
export type DispatchForm = { ref: string; dispatch: boolean; inputs: DispatchInput[] | null }

/** The reactions GitHub offers, by its enum name. */
export const REACTIONS = ['THUMBS_UP', 'THUMBS_DOWN', 'LAUGH', 'HOORAY', 'CONFUSED', 'HEART', 'ROCKET', 'EYES'] as const
export type Reaction = (typeof REACTIONS)[number]
/** One reaction on an issue or comment: how many, whether the viewer is one of them, and the
 *  first few logins (for the tooltip). */
export type ReactionGroup = { content: Reaction; count: number; viewerHasReacted: boolean; users: string[] }

/** Why an issue was closed, as `gh issue close --reason` takes it. */
export type CloseReason = 'completed' | 'not planned' | 'duplicate'

export type TimelineComment = {
  kind: 'comment'
  /** GraphQL node id, for reactions. */
  id: string
  /** REST id, for edit and delete. */
  databaseId: number
  url: string
  author: string | null
  body: string
  /** The body was cut to stay under the panel message limit. */
  truncated: boolean
  createdAt: number
  edited: boolean
  canEdit: boolean
  canDelete: boolean
  reactions: ReactionGroup[]
}
/** Another issue or pull request that mentions this one ("mentioned this"). */
export type TimelineMention = {
  kind: 'mention'
  id: string
  actor: string | null
  createdAt: number
  source: {
    type: 'issue' | 'pull'
    number: number
    title: string
    url: string
    state: IssueState | PullState
    /** `owner/name` of its repo. */
    repo: string
  }
}
export type TimelineState = {
  kind: 'closed' | 'reopened'
  id: string
  actor: string | null
  createdAt: number
  /** Closed events only. */
  reason: 'completed' | 'not_planned' | 'duplicate' | null
}
export type TimelineItem = TimelineComment | TimelineMention | TimelineState

/** One issue with the start and the end of its timeline, as GitHub shows a long one: `head` from the
 *  start, `next` the cursor after it (null once it meets `tail`), `tail` the latest items. */
export type IssueDetail = {
  id: string
  number: number
  title: string
  url: string
  state: IssueState
  author: string | null
  body: string
  truncated: boolean
  createdAt: number
  closedAt: number | null
  labels: string[]
  assignees: string[]
  milestone: string | null
  canEdit: boolean
  reactions: ReactionGroup[]
  comments: number
  /** Timeline items of the kinds shown, in all. */
  total: number
  head: TimelineItem[]
  next: string | null
  tail: TimelineItem[]
  /** The gh login, so the viewer's own reactions read as You. */
  viewer: string | null
}

export type IssueEdit = {
  number: number
  title?: string
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
}
export type IssueCreate = { title: string; body: string; labels?: string[]; assignees?: string[] }
/** A write's answer: nothing more than that it worked. */
export type Done = Answer<Record<never, never>>

declare module 'orca' {
  interface PluginRequests {
    /** The GitHub repo (`owner/name`) of the focused workspace. */
    'repo.get': { output: RepoAnswer }
    /** Picks the folder for the focused branch and name when several workspaces share them
     *  (`ambiguous_workspace`); kept in storage and used until it stops matching. */
    'repo.pick': { input: { path: string }; output: RepoAnswer }
    /** Forgets the pick for the focused branch and name. */
    'repo.unpick': { output: RepoAnswer }
    /** The issue and pull request Orca links to the focused workspace (one made from them), when
     *  they are of its repo; null when there is none or Orca's CLI does not say. */
    'repo.links': { output: Answer<{ issue: number | null; pull: number | null }> }
    /** One page of the focused repo's issues, newest first. */
    'issues.list': { input: ItemListInput; output: Answer<ItemPage<IssueRow>> }
    /** One page of the focused repo's pull requests, newest first. */
    'pulls.list': { input: ItemListInput; output: Answer<ItemPage<PullRow>> }
    /** One page of the focused repo's workflow runs, newest first. */
    'runs.list': { input: RunListInput; output: Answer<RunPage> }
    /** The focused repo's label names, for the label filter. */
    'labels.list': { output: Answer<{ names: string[] }> }
    /** One issue with its body and the start and end of its timeline. */
    'issue.get': { input: { number: number }; output: Answer<{ issue: IssueDetail }> }
    /** The timeline after `after`, up to a page. */
    'issue.timeline': { input: { number: number; after: string }; output: Answer<{ items: TimelineItem[]; next: string | null }> }
    'issue.comment': { input: { number: number; body: string }; output: Done }
    /** Edits or deletes a comment by its REST id. */
    'comment.edit': { input: { id: number; body: string }; output: Done }
    'comment.delete': { input: { id: number }; output: Done }
    /** Closes with a reason; `comment` is posted first, as GitHub's Close with comment does. */
    'issue.close': { input: { number: number; reason: CloseReason; duplicateOf?: number; comment?: string }; output: Done }
    'issue.reopen': { input: { number: number; comment?: string }; output: Done }
    'issue.edit': { input: IssueEdit; output: Done }
    'issue.create': { input: IssueCreate; output: Answer<{ number: number; url: string }> }
    /** Adds or removes the viewer's reaction on an issue or comment, by its node id. */
    'reaction.set': { input: { subjectId: string; content: Reaction; on: boolean }; output: Done }
    /** Logins that can be assigned in the focused repo. */
    'assignees.list': { output: Answer<{ logins: string[] }> }
    /** The focused repo's workflows, for the workflow filter. */
    'workflows.list': { output: Answer<{ workflows: { id: number; name: string }[] }> }
    /** One run and the jobs and steps of its latest attempt. */
    'run.get': { input: { id: number }; output: Answer<{ run: RunDetail }> }
    /** A finished run's failed steps, or with `job` that job's whole log; trimmed to fit a panel
     *  message. */
    'run.logs': { input: { id: number; job?: number }; output: Answer<{ logs: RunLogs }> }
    /** Reruns every job, or only the failed ones (and those that depend on them). */
    'run.rerun': { input: { id: number; failed: boolean }; output: Done }
    'run.cancel': { input: { id: number }; output: Done }
    /** Holds while the run goes on, posting `run.progress` to the asking panel: every 10 s while it
     *  changes, backing off to 60 s while it does not. Answers once the run is done (`done`; with
     *  `attempt`, once that attempt is), or after a while so the panel asks again (a request cannot
     *  outlive 120 s) with `every` and `mark` to carry the cadence on; closing the panel ends it. */
    'run.watch': {
      input: { id: number; attempt?: number; every?: number; mark?: string }
      output: Answer<{ done: boolean; every: number; mark: string | null }>
    }
    /** The Run workflow form of a workflow, read at `ref` (default: the workspace's branch when
     *  GitHub has it, else the repo's default branch). */
    'workflow.form': { input: { workflow: number; ref?: string }; output: Answer<{ form: DispatchForm }> }
    /** Runs a workflow by hand (`workflow_dispatch`) on `ref` with these inputs; `run` is the run it
     *  started once GitHub shows it (a few seconds), else null. */
    'workflow.run': { input: { workflow: number; ref: string; inputs: Record<string, string> }; output: Answer<{ run: number | null }> }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel when the focused workspace's repo answer changes. */
    'repo.changed': RepoAnswer
    /** A watched run as it is now, to the panel that watches it. */
    'run.progress': { run: RunDetail }
  }
}
