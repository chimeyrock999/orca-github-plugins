# Changelog

What changed in gh Focus, newest first. Each version is a tag `vX.Y.Z` and a listing in Orca's
community catalog; how to release one is in `RELEASING.md`.

The format is [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). A user-visible change adds a line under `## Unreleased`
in the PR that makes it, in one of `### Added`, `### Changed`, `### Fixed` or `### Removed`. Within
a subsection, a bold lead-in names the area (Issues and pull requests, Actions, Elsewhere).

## Unreleased

### Changed

- **Issues and pull requests**: Open in Checks, beside a review's comments on the diff, says that
  Orca's Checks tab opens a comment's file at its line.
- **Issues and pull requests**: an open issue or pull request has Back on the left and Orca Tasks →
  (was ← Back to Orca Tasks) on the right of its top row, and Edit and Open on GitHub beside its title.

## 0.1.0 - 2026-11-13

The first release: a right-sidebar panel with the issue, pull request and Actions runs of the
focused workspace, beside your work. Needs Orca 1.4.256 or later and `gh`
logged in.

### Added

**Issues and pull requests**

- Shows only what Orca links to the focused workspace: the only one opens by itself, several show
  as a short list with who opened each, and items of other repos are read and answered in their
  own repo.
- With nothing linked: the `orca reference add` command for this repo, and `Ask <agent> to link`,
  which types the link request into the workspace's free agent without pressing Enter.
- Issue detail: labels, assignees, milestone, body and timeline; comment, edit and delete comments,
  react, close (completed, not planned, duplicate) and reopen, edit the title, body, labels and
  assignees.
- Pull request detail: base and head, review decision, whether it can merge, one line for its
  checks, and the timeline with reviews; comment, react, edit, and review (Comment, Approve,
  Request changes). The branch's pull request stands in when Orca links none.
- Hands off to Orca: Tasks for repo-wide lists, search and new issues; Open in Checks for checks
  and review threads.

**Actions**

- The focused branch's runs, with All branches one press away, search qualifiers and filters.
- Run detail: jobs and steps, failed steps' logs already open, View log, rerun failed or all jobs,
  cancel, and live updates while a run is going.
- Approve or reject a waiting deployment, and list a finished run's artifacts.
- Run workflow with the workflow's `workflow_dispatch` inputs.

**Elsewhere**

- Picks the right workspace when several share a branch, labelled by project and branch.
- Keeps GitHub's answers in memory for a short while and uses conditional reads, so the panel
  spends little of the 5,000 requests an hour it shares with Orca, and warns when few are left.
- When a request fails, the panel says why, with a hint and Retry (for example "GitHub rate limit
  reached": wait a few minutes, then press Retry).
- Catalog icon.
- Tabs are words only, and the panel fits a narrow sidebar (280 px) without scrolling sideways.
