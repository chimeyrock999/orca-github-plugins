# GitHub

A right-sidebar panel with the issues, pull requests and Actions runs of the focused workspace's repo. Every GitHub call goes through the `gh` CLI already logged in on the machine; the plugin stores no tokens. The panel (`src/panel.tsx`) asks with `plugin.request`, the plugin's own worker (`src/worker.ts`) answers with `orca.panels.handle` and runs `gh`; `src/protocol.ts` types both sides. Orca transpiles both files when they load, so there is no build step: save and the panel or worker reloads.

## Panel

Tabs Issues | Pull requests | Actions, each with its own search, filters, order, page and open row. A list takes the panel's height and shows GitHub's page of 30 rows, with Previous / Next pinned under it; GitHub's search stops at 1,000 results (so does the runs list once a filter is set), and the page line says so. Issues and pull requests show their open and closed counts beside Open and Closed, counted when the list starts over, not on every page. The filter button opens author and label (workflow, status, event and branch for runs) and shows how many are on; the sort button opens newest, oldest, recently updated and most commented (runs have no order to choose). A row opens a short detail, and Back returns to the list. Refresh asks for the repo again and reloads the page on screen; Open on GitHub opens the tab's page of the repo, or the open row. A state shows as a tinted glyph (Orca tones, so it follows the theme): open green, done and merged in the text colour, not planned, draft, cancelled and skipped grey, closed and failed red, running and waiting amber.

## Files

- `src/protocol.ts`: the requests `repo.get`, `repo.pick`, `repo.unpick`, `issues.list`, `pulls.list`, `runs.list`, `labels.list`, `workflows.list` and the event `repo.changed`. Every answer is `Answer<T>`: `{ ok: true, ... }` or `{ ok: false, error: { code, message } }`, since a thrown code would reach the panel only as `action_failed`.
- `src/gh.ts`: `runGh(args, { cwd, signal, json })` runs `gh` and throws a `GhError` whose `code` the panel can explain. Handlers take it injected, so tests never call real GitHub.
- `src/exec.ts`: `run` (child processes, with the user's PATH first) and `terminalPath` (the folder a terminal runs in, from the Orca CLI). The CLI is looked for in the macOS app bundle, then as `orca` on PATH; on Linux and Windows only PATH is tried, so without `orca` on PATH a terminal never breaks a tie and the panel asks for a pick instead.
- `src/focus.ts`: finds the focused workspace's folder. `workspace.readContext` gives only a branch and a name, so it matches them against `workspace.list`, and when that is not one workspace (root clones are named after their branch, so every repo on `main` looks alike) it asks which folder a focused terminal runs in, since that terminal belongs to the focused workspace, and when none tells it uses the folder the person picked for that branch and name (kept in storage under `picks`, shared by every clone with that branch and name, used while it still matches, forgotten with Change workspace). With neither, the panel lists the candidates to pick from.
- `src/repo.ts`: `gh repo view --json nameWithOwner,url` in that folder, and the tracker behind `repo.get`: it follows `workspace.changed`, keeps a found repo per folder, asks again after an error, and posts `repo.changed` to open panels when the answer changes.
- `src/lists.ts`: one page per request. Issues and pull requests go through GitHub's GraphQL search (`repo:o/r is:issue is:open author:… label:… sort:created-desc <words>`), which pages by cursor and, when asked, counts open and closed in the same call. Runs go through the REST `actions/runs` API, paged by number; it has no word search, so the runs search takes qualifiers only: `branch:`, `status:`, `actor:`, `event:`, `workflow:` (an id, a file name, or a workflow name looked up first; quote a name with spaces). Also the repo's label names and workflows, for the filters.
- `src/look.ts`: glyph, tone and words for each state and error code.
- `src/store.ts`: the panel's atoms and actions: the selected tab, and per tab the search, open/closed, filters, order, counts, a stack of page cursors and the open row.
- `src/views.tsx`, `src/panel.tsx`: the components.
- `src/panel.check.ts`: `orca plugin check` scenarios, with the worker stubbed: no workspace, several workspaces to pick from, not a GitHub repo, gh logged out, empty repo, rate limited, and each tab with rows.

Error codes: `no_workspace`, `workspace_not_found`, `ambiguous_workspace` (with `candidates`), `remote_workspace`, `host_failed`, `not_a_repo`, `gh_missing`, `gh_logged_out`, `not_found`, `rate_limited`, `timeout`, `cancelled`, `bad_query`, `gh_failed`.

## Develop

```sh
orca plugin types .        # typings into .orca/types/, needed before tsc
orca plugin validate .
orca plugin test .         # GH_LIVE=1 also runs src/repo.test.ts against the real gh
orca plugin check .
npm install && npx tsc -p .
orca plugin dev watch .    # loads this folder into Orca and prints its logs and reloads; Ctrl-C unloads it
orca plugin dev request . issues.list --data '{"state":"open","query":"","after":null}'
```

Orca names the publisher after where the plugin is installed from: the GitHub or GitLab owner of
its repository, or `local` for a folder. See
https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md.
