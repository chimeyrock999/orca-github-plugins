# orca-github-plugins

Plugins for [Orca](https://github.com/stablyai/orca). The one here is **gh Focus**: the issue,
pull request and Actions runs of the workspace you're in, beside your code.

## Goal

A right-sidebar panel that follows the focused workspace, so you read and answer comments, review,
and watch this branch's runs without leaving the editor for the Tasks page. It stays small and
focused on the work at hand: the detail work (merge, reviewers, the files diff, Projects) stays on
Orca's Tasks page and pull request page, and the panel hands off to them. Vision and plan: #20, #1.

All GitHub calls go through the `gh` CLI that is already logged in on the machine,
so the plugin holds no tokens of its own.

## Plugins

| Plugin | Folder | Type |
| :--- | :--- | :--- |
| gh Focus (`gh-focus`) | [`plugins/gh-focus`](plugins/gh-focus) | `trusted-worker` |

gh Focus follows the focused workspace, with three tabs and the hand-offs to Orca:

- **Issues**: the issues Orca links to the workspace, those of another repo too (read and
  answered in their own repo); read, comment, react, close or reopen, edit.
- **Pull requests**: the workspace's pull request, or a short list of the linked ones; its review state, merge state and checks in a
  line each; comment, react, edit, review.
- **Actions**: the branch's runs; jobs, failed logs, rerun, cancel, deployment approval,
  artifacts, Run workflow, live updates.
- **Hand-offs**: Orca's Tasks page for the repo's lists and new issues, Orca's Checks tab for
  review threads and check logs.

Features, requirements and the permissions it asks for: [`plugins/gh-focus/README.md`](plugins/gh-focus/README.md).

## Install

From the first release on (#20): [Open in Orca](https://orca.dev/plugins/chimeyrock999.gh-focus?catalog=community), or in Orca:
Settings → Plugins, community catalog, **gh Focus**. Needs Orca `1.4.256`+ and `gh` logged in.
gh Focus is not affiliated with GitHub.

## Develop

Needs Orca `1.4.256`+ with its `orca` CLI on PATH for the commands below, Node.js 18+, and `gh`
logged in.

```sh
cd plugins/gh-focus
orca plugin types .                 # typings, needed before tsc
npm install
orca plugin validate .
orca plugin test .
orca plugin check .
npx tsc -p .
orca plugin dev watch .             # load into Orca with live reload
```

All four checks (validate, test, check, tsc) pass before a pull request; pull requests go into
`dev`. More in [`plugins/gh-focus/README.md`](plugins/gh-focus/README.md#develop) and `CLAUDE.md`.

## Releases

What changed in each version: [`CHANGELOG.md`](CHANGELOG.md). How to cut a release or a hotfix:
[`RELEASING.md`](RELEASING.md).
