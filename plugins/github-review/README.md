# GitHub Review

A right-sidebar panel (`src/panel.tsx`) and the plugin's own worker (`src/worker.ts`). The panel asks with `plugin.request`, the worker answers with `orca.panels.handle`, keeps the total in `orca.storage` and tells every open panel with `orca.panels.post`; `src/protocol.ts` types both sides. Orca transpiles both files when they load, so there is no build step: save and the panel or worker reloads (a worker reload drops its in-memory state, so keep what must last in storage). `orca plugin test .` runs `src/panel.test.tsx` and `src/worker.test.ts` in Node with `orca/testing`, and `orca plugin check .` renders the panel with the worker in each `src/panel.check.ts` scenario; `npm install && npx tsc -p .` type-checks against the typings `orca plugin types .` writes to `.orca/types/` and Node's (`@types/node`). With the folder loaded, `orca plugin dev request . counter.add --data '{"by":1}'` calls the worker as the panel does.

## Repo of the focused workspace

`repo.get` answers `{ ok: true, nameWithOwner, path, resolvedBy }` for the focused workspace, or `{ ok: false, error: { code, message } }`; the worker follows `workspace.changed` and posts `repo.changed` to open panels when the answer changes. `src/focus.ts` finds the workspace folder: `workspace.readContext` gives only a branch and a name, so it matches them against `workspace.list`, and when that is not one workspace (root clones are named after their branch, so every repo on `main` looks alike) it asks the Orca CLI (`orca terminal show`) which folder a focused terminal runs in. `src/exec.ts` then runs `gh repo view --json nameWithOwner` in that folder. Error codes: `no_workspace`, `workspace_not_found`, `ambiguous_workspace` (with `candidates`), `remote_workspace`, `host_failed`, `not_a_repo`, `gh_missing`, `gh_logged_out`, `gh_failed`. `GH_LIVE=1 orca plugin test .` also runs the test against the real `gh`.

## Develop

```sh
orca plugin validate .
orca plugin dev watch .    # loads this folder into Orca and prints its logs and reloads; Ctrl-C unloads it
```

Orca names the publisher after where the plugin is installed from: the GitHub or GitLab owner of
its repository, or `local` for a folder. See
https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md.
