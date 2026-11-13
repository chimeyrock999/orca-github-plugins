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
| gh Focus (`gh-focus`) | [`plugins/gh-focus`](plugins/gh-focus) | `trusted-worker` | Tabs; the issues and pull requests linked to the workspace (opens the only one, lists several, items of other repos read and answered in their own repo, with nothing linked the link command and Ask agent); issue: detail, comments, close/reopen, edit, reactions; pull request: detail, checks line, comments, review, edit, reactions; hand-offs to Orca's Tasks page and Checks tab; Actions: the focused branch's runs, run detail, logs, rerun, cancel, deployment approval, artifacts, Run workflow, live runs |

## Install

From the first release on (#20): [Open in Orca](https://orca.dev/plugins/chimeyrock999.gh-focus?catalog=community), or in Orca:
Settings → Plugins, community catalog, **gh Focus**. Needs Orca `1.4.256`+ and `gh` logged in.
gh Focus is not affiliated with GitHub.

## Develop

Needs Orca `1.4.256`+ (`orca` on PATH), Node.js 18+, and `gh` logged in.

```sh
orca plugin validate ./plugins/gh-focus
orca plugin test ./plugins/gh-focus
orca plugin dev watch ./plugins/gh-focus
```

## Releases

What changed in each version: [`CHANGELOG.md`](CHANGELOG.md). How to cut a release or a hotfix:
[`RELEASING.md`](RELEASING.md).
