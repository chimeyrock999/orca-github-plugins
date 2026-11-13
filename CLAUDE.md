# CLAUDE.md

Orca plugins for working on GitHub from Orca's sidebar. Goal and feature list: `README.md`.
Plan: tracking issue #1, one sub-issue per step (#2 → #8).

## Layout

- `plugins/gh-focus/`: the only plugin so far, **gh Focus** (id `gh-focus`), a `trusted-worker` with one
  components panel `gh-focus`. The folder and the panel id stay named after the id: the catalog
  pins the folder as `source.path` (`tests/manifest.test.ts` checks both).
- `src/` holds only code that runs in Orca, split by side, then by feature. The entries stay where the
  manifest points.
  - `src/worker.ts`: Node worker entry, wires the panel requests (`orca.panels.handle`) to `src/worker/`.
  - `src/panel.tsx`: components panel entry (`"ui": "components"`); `src/panel.check.ts`: its render
    scenarios, beside it.
  - `src/shared/`: imported by both sides, so no `node:`, `orca/worker`, and `orca` (the panel
    runtime) for its types only.
    - `protocol.ts`: the panel ↔ worker contract (`PluginRequests`, `PluginPanelEvents`).
    - `look.ts`: glyphs, tones and words; the worker uses it for the link command.
    - `host-error.ts`: what a rejected Orca call means to the panel (`hostFailure`), used by the
      panel's `requestFailed` and the worker's host calls.
  - `src/worker/`: Node side only.
    - `gh.ts`: `runGh` and `GhError` codes; every GitHub call goes through it, a plain REST GET as a
      conditional read (`etag`). `exec.ts`: child processes and the Orca CLI.
    - `cache.ts`: what the worker keeps of GitHub's answers, in memory only: `Reads` (a TTL per
      answer, one gh call for identical reads in flight, dropped by tag on writes, `repo.changed`
      and Refresh), `withEtags` (a 304 answers the kept body and costs no budget) and `Budget` (the
      REST budget left, low under a tenth of the limit: longer TTLs, slower `run.watch`, and the
      panel's warning).
    - `lists.ts`: one page of runs (REST), the repo's labels and workflows; `timeline.ts`: the
      timeline issues and pull requests share (GraphQL pages, cut to fit the message limit).
    - `linked/linked.ts`: what Orca links to the workspace (`orca worktree show`'s `linkedItems`,
      read in `exec.ts`), their state from GitHub in one GraphQL query, and the free agent Ask agent
      types into.
    - `repo/` (`repo.ts`, `focus.ts`): the focused workspace's repo, `repo.get`, `repo.changed`.
    - `issues/issues.ts`: one issue (GraphQL body and timeline) and its writes (gh issue commands;
      a comment through the REST API, which answers the comment the panel then shows in place).
    - `pulls/pulls.ts`: one pull request (refs, merge state, review decision, checks, timeline with
      reviews and the merge), its writes (a comment as on an issue, `gh pr edit`, `review`) and the
      branch's pull request (`gh pr view`).
    - `runs/` (`runs.ts`, `logs.ts`, `workflow-inputs.ts`): one run, its logs, rerun, cancel, the
      `run.watch` lease, and the Run workflow form.
  - `src/panel/`: panel side only; no DOM, no `node:`, only the `orca` catalog; state in atoms.
    - `views.tsx`, `store.ts`, `parts.tsx`: the tabs, their atoms, shared pieces; `refs.ts`: `#N`
      links.
    - `linked/` (`linked-view.tsx`, `link-store.ts`): the Issues and Pull requests tabs with nothing
      open: the linked list (nothing repo-wide), or how to link one (the command, Ask agent), and
      the hand-offs to Orca's Tasks page and Checks tab.
    - `thread/` (`thread-store.ts`, `thread-view.tsx`): an open issue or pull request (a thread), one
      per tab, and the pieces both draw (posts, reactions, timeline, pickers).
    - `issues/` (`issue-view.tsx`, `issue-store.ts`): the issue detail and state.
    - `pulls/` (`pull-view.tsx`, `pull-store.ts`): a pull request and its review.
    - `runs/` (`run-store.ts`, `run-view.tsx`): the panel side of runs.
- `tests/` mirrors `src/`: the test of `src/<path>/<name>.ts` is `tests/<path>/<name>.test.ts(x)`
  (`orca plugin test` finds it there). `tests/fixtures/` holds the canned answers (`fixtures.ts` for
  the panel and the check scenarios, `worker-fixtures.ts` for the worker). `tests/manifest.test.ts`
  checks the listing rules (name, engines, metadata, and the catalog images' size and byte limits);
  `tests/layout.test.ts` checks the import rules below. `tests/requests.test.ts` counts the gh calls
  each screen costs through the real worker (the numbers of #39); `tests/panel/requests.test.tsx`
  what the panel asks for to spend less.
- Where new files go: a new feature gets a folder on each side it touches (`src/worker/<feature>/`,
  `src/panel/<feature>/`) and its tests at the same paths under `tests/`. Code both sides import goes
  in `src/shared/`. Only the entries and the check scenarios sit directly in `src/`.
- Import rules (`tests/layout.test.ts`): `src/shared/` never imports from `src/worker/` or
  `src/panel/`, nor `orca` except `import type`; the panel (`src/panel/`, `src/panel.tsx`) never
  imports Node built-ins (`node:fs` or `fs`), `orca/worker` or worker code; the worker
  (`src/worker/`, `src/worker.ts`) never imports panel code; nothing in `src/` imports from
  `tests/`, except `src/panel.check.ts` borrowing fixtures. It also checks that only the entries and
  the check scenarios sit directly in `src/`, and that no test or fixture sits under it.
- `images/`: the catalog listing's icon (`icon.png`), cover and screenshots (`icon`, `cover`,
  `screenshots` in `orca-plugin.json`); the screenshots are taken by hand from Orca, see "Listing
  images" in `RELEASING.md`.
- `.orca/types/` is generated by `orca plugin types .` and gitignored; read it for the real API
  (host methods, components and their props). Do not guess an API that is not in there.

## Commands (from `plugins/gh-focus/`)

```sh
orca plugin types .        # (re)write typings, needed before tsc
orca plugin validate .
orca plugin test .
orca plugin check .
npx tsc -p .
orca plugin dev watch .    # load into Orca with live reload
orca plugin dev request . <name> --data '<json>'
orca plugin shot ...       # PNG of the panel as Orca draws it
```

All four checks (validate, test, check, tsc) pass before a PR.

## Rules

- Every GitHub call goes through the `gh` CLI already logged in on the machine. The plugin
  stores no tokens.
- Tests never call real GitHub: inject the `gh` runner and fake it.
- Limits to design around: `plugin.request` times out at 30 s by default (120 s max);
  `panels.post` payloads are at most 256 KiB; panel `Markdown` cannot load remote images.
- Destructive actions (close, merge, cancel, delete) ask for confirmation in the panel.
- The panel shares the user's GitHub budget with Orca. A new read goes through `kept` in
  `src/worker.ts` (short TTL for what changes, long for labels, assignees, workflows); a new write
  through `inItems` / `inRuns` (or `written`), so it drops what it can change. Refresh drops
  everything (`cache.drop`), and nothing is stored on disk.

## Learn from Orca's own GitHub features

Orca already ships GitHub issues, pull requests and checks. Before you design or build a view or
an action, read how Orca does it, in the code (https://github.com/stablyai/orca) and in the app.
Reuse what fits: its GitHub queries and fields, how it handles `gh` errors and rate limits, the
words, glyphs, order, filters and confirmations. Then decide what the panel adds.

Where it lives, in the app and in the Orca source:

| Orca feature | In the app | Code |
| :--- | :--- | :--- |
| Issue and PR lists, filters, GitHub Projects; issue dialog with Activity, edit, comment, close/reopen, reactions | **Tasks** (left sidebar) → GitHub | `src/renderer/src/components/task-page/github/`, `github-item-dialog/`; `src/main/github/issues/`, `work-items/`, `project-view/` |
| Linked PR and issue of a workspace, failing-checks chip, PR menu (copy link, close, reopen) | Workspace row in the left sidebar | `src/renderer/src/components/sidebar/`; `src/main/github/workspace-links/` |
| Checks of the worktree's PR, job logs, rerun, review threads | **Checks** tab (right sidebar) | `src/renderer/src/components/right-sidebar/checks-panel/`; `src/main/github/client/check/` |
| PR conversation, files, checks, reviewers, review, merge, auto-merge, merge queue, stacks, "Fix broken checks" | PR page (a tab) | `src/renderer/src/components/pull-request-page/`; `src/main/github/pull-requests/` |
| Create a PR | **Source Control** tab (right sidebar) | `src/renderer/src/components/right-sidebar/source-control/` |

User docs: `docs/site/content/docs/review/github.mdx` and `docs/site/content/docs/github-errors.mdx`
in the Orca repo.

What the panel is for:

- **Goal: small, no duplicates, focused on the work at hand.** You read and answer the issue and
  pull request of the focused workspace beside the code, without leaving the terminal or editor
  for another tab. A feature that Orca already has, or that pulls you away from the current work,
  is left out or handed off; when in doubt, leave it out.
- A side panel that follows the focused workspace: what you look at while you work, with short
  actions. It does not rebuild what Orca does better (diff review, merge queue, stacks, Projects).
- It hands heavy work to Orca: `commands.run` with `view.tasks` or `sidebar.checks.toggle` (needs
  `workspace:write`), and `workspace.create` to check out a pull request as a worktree. No host
  method opens a given issue or PR in Orca's own views, so the detail opens in the panel or on
  GitHub.
- Orca has no list of a repo's workflow runs, only checks per PR, so Actions (#7) is the panel's
  own ground.

## Release to the community catalog

How to release, hotfix, and retake the listing images: `RELEASING.md`. In short, a `dev` → `main`
release PR merged with a merge commit, then a `vX.Y.Z` tag on it. Never change after the first
release: the id `gh-focus`, the folder `plugins/gh-focus`, or a pushed tag. A user-visible change
adds a line under `## Unreleased` in `CHANGELOG.md`.

## Git and GitHub

- Branches: `main` and `dev`. PRs target `dev`; only `hotfix/*` or the `dev` → `main` release PR
  go into `main`.
- The repo lives under `chimeyrock999`, which may not be the active `gh` account. Pass its
  token per command instead of `gh auth switch`:
  `GH_TOKEN=$(gh auth token --user chimeyrock999) gh ... -R chimeyrock999/orca-github-plugins`.
