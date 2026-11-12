# orca-github-plugins

Plugins for [Orca](https://github.com/stablyai/orca) that let you work on GitHub
issues and pull requests without leaving Orca.

## Goal

Read and act on GitHub from Orca's sidebar, for the repo of the active workspace:

- **Issues**: list, filter, open one and read its body and comments.
- **Pull requests**: list, filter, read the description, checks, review status and comments.
- **Comment**: reply on an issue or PR.
- **Review**: approve a PR or request changes.
- **Merge**: merge a PR (merge, squash or rebase) once it is mergeable.

All GitHub calls go through the `gh` CLI that is already logged in on the machine,
so the plugin holds no tokens of its own.

## Plugins

| Plugin | Type | Status |
| :--- | :--- | :--- |
| [`plugins/github-review`](plugins/github-review) | `trusted-worker` | Scaffolded, not built yet |

## Develop

Needs Orca `1.4.248`+ (`orca` on PATH), Node.js 18+, and `gh` logged in.

```sh
orca plugin validate ./plugins/github-review
orca plugin test ./plugins/github-review
orca plugin dev watch ./plugins/github-review
```
