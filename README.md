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

| Plugin | Folder | Type | Status |
| :--- | :--- | :--- | :--- |
| gh Focus (`gh-focus`) | [`plugins/github`](plugins/github) | `trusted-worker` | Tabs, lists, paging, search; issues: detail, comments, close/reopen, edit, create, reactions; Actions: the focused branch's runs, run detail, logs, rerun, cancel, Run workflow, live runs |

## Install

From the first release on (#20): [Open in Orca](https://orca.dev/plugins/chimeyrock999.gh-focus?catalog=community), or in Orca:
Settings → Plugins, community catalog, **gh Focus**. Needs Orca `1.4.256`+ and `gh` logged in.
gh Focus is not affiliated with GitHub.

## Develop

Needs Orca `1.4.256`+ (`orca` on PATH), Node.js 18+, and `gh` logged in.

```sh
orca plugin validate ./plugins/github
orca plugin test ./plugins/github
orca plugin dev watch ./plugins/github
```
