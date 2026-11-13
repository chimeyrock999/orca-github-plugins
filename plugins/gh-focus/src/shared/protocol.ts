// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.

/** Why an answer has no data: finding the focused workspace, asking gh, or reading its answer. */
export type ErrorCode =
  | 'no_workspace'
  | 'workspace_not_found'
  | 'ambiguous_workspace'
  | 'remote_workspace'
  /** An Orca call failed without a code: a host call (workspace.readContext, workspace.list) or a
   *  panel request. One with a code reads as the codes below (src/shared/host-error.ts). */
  | 'host_failed'
  /** The worker threw something that is not a gh failure, or Orca refused a call as malformed. A
   *  bug in the plugin. */
  | 'action_failed'
  /** Orca has not allowed this for the plugin (capability_denied, consent_required,
   *  not_permitted). */
  | 'not_allowed'
  /** Orca's own pace for panel requests and host calls, with `retryAfterMs` when Orca says how long. */
  | 'host_rate_limited'
  /** Panel only: the answer is bigger than Orca passes to a panel. */
  | 'too_large'
  /** Orca could not reach the plugin's worker, or does not offer a host method. */
  | 'unavailable'
  | 'not_a_repo'
  | 'gh_missing'
  | 'gh_logged_out'
  /** GitHub has no such repo, issue, run or workflow, or this login cannot see it. */
  | 'not_found'
  /** GitHub's rate limit. */
  | 'rate_limited'
  /** gh did not answer within the worker's limit, or Orca timed out a host call or panel request. */
  | 'timeout'
  /** The panel stopped waiting (closed, or the request timed out). */
  | 'cancelled'
  /** A search the API cannot run, such as plain words in a runs search. */
  | 'bad_query'
  | 'gh_failed'
  /** Panel only: a write got no answer in time, so it may or may not have landed. */
  | 'unsure'
  /** No agent in the focused workspace is free to take a prompt (all working, or none). */
  | 'no_agent'

export type PanelError = {
  code: ErrorCode
  message: string
  /** The workspace folder, once one was found. */
  path?: string
  /** The workspaces that fit the focused context equally well (`ambiguous_workspace`), with the
   *  repo's name in Orca (null when Orca does not say) and the branch, both for the label;
   *  choices that share both add their folder name. */
  candidates?: { id: string; name: string; path: string; project: string | null; branch: string }[]
  /** How long Orca asks the panel to wait (`host_rate_limited`). */
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
 *  how many rows GitHub lets anyone page through (its filtered runs list stops at 1,000 however many
 *  match); null when every row can be reached. */
export type Page<Row> = { rows: Row[]; total: number; next: string | null; limit: number | null }

/** Rows per page: GitHub's own page size. */
export const PAGE_SIZE = 30
/** The most results GitHub's filtered runs list returns. */
export const SEARCH_LIMIT = 1000

export type IssueState = 'open' | 'done' | 'not_planned'
export type PullState = 'open' | 'draft' | 'merged' | 'closed'
/** `queued`: not started yet. `waiting`: a deployment or approval holds it. `skipped`: skipped,
 *  neutral or stale. Runs, jobs and steps share it. */
export type RunState = 'success' | 'failure' | 'running' | 'queued' | 'waiting' | 'cancelled' | 'skipped'

/** Whether `name` is a GitHub `owner/name`: an owner of letters, digits and dashes, and a repo name
 *  of letters, digits, `.`, `_` and `-` that is not `.` or `..`. Names go into gh arguments, API paths
 *  and query text, so the worker and the link parser take nothing else. */
export function isRepoName(name: string): boolean {
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)$/.exec(name)
  return !!m && m[2] !== '.' && m[2] !== '..'
}

/** The most linked items the panel asks GitHub about in one call; the list says when there are more. */
export const LINKED_LIMIT = 50

/** The two tabs that show what Orca links to the workspace. */
export type LinkedKind = 'issues' | 'pulls'

/** An issue or pull request Orca links to the focused workspace: `repo` is its `owner/name` when it
 *  is of another repo, null when it is of the focused one; `title` and `url` as Orca keeps them. */
export type LinkedRef = { number: number; repo: string | null; title: string | null; url: string | null }

/** An agent of the focused workspace that can take a prompt, by the name the panel shows. */
export type FreeAgent = { name: string; terminalId: string }

/** A linked issue or pull request as GitHub has it now. `state` and `updatedAt` are null when
 *  GitHub did not answer for it (gone, or this login cannot see it): then title and url are Orca's. */
export type LinkedRow = {
  number: number
  repo: string | null
  title: string
  url: string
  state: IssueState | PullState | null
  /** Milliseconds since the epoch. */
  updatedAt: number | null
  /** Who opened it; null for a deleted account, or an item GitHub has no answer for. */
  author: string | null
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

/** An environment a waiting run needs a deployment approval for; `canApprove` when this login may
 *  approve or reject it (one of its required reviewers). */
export type PendingDeployment = { id: number; name: string; canApprove: boolean }

/** A file a run uploaded. `expired` ones are gone from GitHub; `expiresAt` null when GitHub gives no
 *  date. */
export type RunArtifact = { id: number; name: string; bytes: number; expired: boolean; expiresAt: number | null }

/** One run with the jobs of its latest attempt. `done` once it is completed: nothing changes after.
 *  `waitingFor`: the environments a waiting run needs a deployment approval for. `artifacts`: read
 *  once the run is done (none while it goes on, or when they could not be read), at most 100;
 *  `moreArtifacts` counts the rest. */
export type RunDetail = RunRow & {
  attempt: number
  workflowId: number
  done: boolean
  jobs: RunJob[]
  waitingFor: PendingDeployment[]
  artifacts: RunArtifact[]
  moreArtifacts: number
}

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
  /** Closed events of issues only; null for a reopened event or a pull request. */
  reason: 'completed' | 'not_planned' | 'duplicate' | null
}
export type TimelineItem = TimelineComment | TimelineMention | TimelineState | TimelineReview | TimelineMerged

export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed'
/** A submitted pull request review: its body, and how many comments it left on the diff (shown
 *  on GitHub only). */
export type TimelineReview = {
  kind: 'review'
  id: string
  url: string
  author: string | null
  state: ReviewState
  body: string
  truncated: boolean
  createdAt: number
  /** Comments on the diff. */
  comments: number
  reactions: ReactionGroup[]
}
export type TimelineMerged = {
  kind: 'merged'
  id: string
  actor: string | null
  createdAt: number
  /** Short sha of the merge commit, and the branch it went into. */
  commit: string
  into: string
}

/** What an issue and a pull request share: the body, labels, assignees and milestone, and the start
 *  and the end of the timeline, as GitHub shows a long one: `head` from the start, `next` the cursor
 *  after it (null once it meets `tail`), `tail` the latest items. */
export type ThreadDetail = {
  /** GraphQL node id, for reactions. */
  id: string
  number: number
  title: string
  url: string
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

export type IssueDetail = ThreadDetail & { state: IssueState }

/** Whether a pull request can be merged now, from GitHub's merge state: `unstable` is a passing
 *  required set with other checks failing, `unknown` while GitHub is still working it out. */
export type MergeState = 'clean' | 'conflicts' | 'behind' | 'blocked' | 'unstable' | 'draft' | 'unknown'
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | null
/** The head commit's checks counted as Orca counts them, so the panel and Orca's Checks tab agree:
 *  skipped passes; cancelled and those that need an action (an approval) are told apart from the
 *  failing; neutral and stale are neither. */
export type CheckCounts = { passed: number; failed: number; cancelled: number; needsAction: number; pending: number; neutral: number }

export type PullDetail = ThreadDetail & {
  state: PullState
  /** The branch it merges into. */
  baseRef: string
  /** The branch it merges from, as `owner:branch` when that is in a fork. */
  headRef: string
  mergedAt: number | null
  merge: MergeState
  review: ReviewDecision
  /** Reviews asked for and not given yet: logins, or team names. */
  reviewers: string[]
  /** Counted from GitHub's rollup, every check; null when the head commit has none. Orca's Checks
   *  tab lists them, with logs and reruns. */
  checks: CheckCounts | null
}

/** Orca's own views the panel hands off to. */
export type OrcaView = 'tasks' | 'checks'

/** The review `gh pr review` submits. */
export type ReviewEvent = 'approve' | 'request_changes' | 'comment'

export type IssueEdit = {
  number: number
  title?: string
  body?: string
  addLabels?: string[]
  removeLabels?: string[]
  addAssignees?: string[]
  removeAssignees?: string[]
}
/** A write's answer: nothing more than that it worked. */
export type Done = Answer<Record<never, never>>

/* An issue or pull request request with `repo` (`owner/name`) reads or writes that repo instead of
 * the focused one: an item Orca links to the workspace from another repo. */
declare module 'orca' {
  interface PluginRequests {
    /** The GitHub repo (`owner/name`) of the focused workspace. */
    'repo.get': { output: RepoAnswer }
    /** Picks the folder for the focused branch and name when several workspaces share them
     *  (`ambiguous_workspace`); kept in storage for this branch, name and set of matching projects,
     *  and used while that set stays the same and the folder is one of them. */
    'repo.pick': { input: { path: string }; output: RepoAnswer }
    /** Forgets the pick for the focused branch, name and set of matching projects. */
    'repo.unpick': { output: RepoAnswer }
    /** The issues and pull requests Orca links to the focused workspace, in Orca's order; none when
     *  Orca's CLI does not say. With `branch` and no linked pull request of the focused repo, the one
     *  gh finds for the workspace's branch comes first (a gh call, so only the Pull requests tab
     *  asks for it). */
    'repo.links': { input: { branch?: boolean }; output: Answer<{ issues: LinkedRef[]; pulls: LinkedRef[] }> }
    /** The linked issues or pull requests as GitHub has them now (one call), newest activity first. */
    'items.get': { input: { kind: LinkedKind; items: LinkedRef[] }; output: Answer<{ rows: LinkedRow[] }> }
    /** A free agent of the focused workspace (one not working or blocked): its name and terminal;
     *  null when none. */
    'agent.find': { output: Answer<{ agent: FreeAgent | null }> }
    /** Types a prompt into that agent's terminal asking it to link the workspace's issue or pull
     *  request with `orca reference add`, when it is still free; Enter is left to the person. */
    'agent.ask': { input: { kind: LinkedKind; terminalId: string }; output: Answer<{ agent: string }> }
    /** One page of the focused repo's workflow runs, newest first. */
    'runs.list': { input: RunListInput; output: Answer<RunPage> }
    /** The focused repo's label names, for the label picker. */
    'labels.list': { input: { repo?: string }; output: Answer<{ names: string[] }> }
    /** One issue with its body and the start and end of its timeline. */
    'issue.get': { input: { number: number; repo?: string }; output: Answer<{ issue: IssueDetail }> }
    /** The timeline after `after`, up to a page. */
    'issue.timeline': { input: { number: number; after: string; repo?: string }; output: Answer<{ items: TimelineItem[]; next: string | null }> }
    'issue.comment': { input: { number: number; body: string; repo?: string }; output: Done }
    /** Edits or deletes a comment by its REST id. */
    'comment.edit': { input: { id: number; body: string; repo?: string }; output: Done }
    'comment.delete': { input: { id: number; repo?: string }; output: Done }
    /** Closes with a reason; `comment` is posted first, as GitHub's Close with comment does. */
    'issue.close': { input: { number: number; reason: CloseReason; duplicateOf?: number; comment?: string; repo?: string }; output: Done }
    'issue.reopen': { input: { number: number; comment?: string; repo?: string }; output: Done }
    'issue.edit': { input: IssueEdit & { repo?: string }; output: Done }
    /** Adds or removes the viewer's reaction on an issue or comment, by its node id. */
    'reaction.set': { input: { subjectId: string; content: Reaction; on: boolean }; output: Done }
    /** One pull request with its checks, body and the start and end of its timeline. */
    'pull.get': { input: { number: number; repo?: string }; output: Answer<{ pull: PullDetail }> }
    'pull.timeline': { input: { number: number; after: string; repo?: string }; output: Answer<{ items: TimelineItem[]; next: string | null }> }
    'pull.comment': { input: { number: number; body: string; repo?: string }; output: Done }
    'pull.edit': { input: IssueEdit & { repo?: string }; output: Done }
    /** Approve, request changes (with a body) or comment (with a body). */
    'pull.review': { input: { number: number; event: ReviewEvent; body: string; repo?: string }; output: Done }
    /** Shows one of Orca's own views: its Tasks page, or the Checks tab of the right sidebar. */
    'orca.show': { input: { view: OrcaView }; output: Done }
    /** Logins that can be assigned in the focused repo. */
    'assignees.list': { input: { repo?: string }; output: Answer<{ logins: string[] }> }
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
    /** Approves (`approve`) or rejects the deployments a waiting run needs in these environments
     *  (ids from `waitingFor`), with GitHub's empty comment. */
    'run.review': { input: { id: number; approve: boolean; environments: number[] }; output: Done }
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
