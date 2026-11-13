# Releasing gh Focus

gh Focus ships through Orca's community catalog. There is no form and no review queue: Orca lists
any public repository with the `orca-plugin` topic and a `vX.Y.Z` tag whose plugin passes
`orca plugin validate` and the
[listing policy](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-listing-policy.md),
usually within an hour. The newest tag is pinned to its commit and content hash, and a listed
version never changes.

Commands below run from the repository root. The repository belongs to `chimeyrock999`, which may
not be the active `gh` account, so pass its token per command:

```sh
export GH_TOKEN=$(gh auth token --user chimeyrock999)
```

## Branches

- `dev` takes every feature and fix PR.
- `main` takes only the release PR `dev` → `main` and `hotfix/*` PRs. Every tag sits on `main`.
- Merge PRs into `main` with **Create a merge commit**, never squash or rebase: a squashed release
  rewrites `dev`'s commits on `main`, and the next release PR conflicts with them. To rule it out,
  allow only merge commits in Settings → General → Pull Requests.

## Release

1. **Prepare `dev`** (a normal PR into `dev`):
   - Bump `version` in `plugins/gh-focus/orca-plugin.json`. A listed version never changes, so every
     release needs a new one. The first release keeps the `0.1.0` already there.
   - In `CHANGELOG.md`, rename `## Unreleased` to `## X.Y.Z - YYYY-MM-DD` and start a new empty
     `## Unreleased` above it.
   - If the panel's look changed since the last release, retake the listing images (below).
   - Raise `engines.orca` only if the release uses something newer Orca added. Orca keeps offering
     the previous release to older Orca.
2. **Check `dev`** from `plugins/gh-focus/`: `orca plugin validate .`, `orca plugin test .`,
   `orca plugin check .`, `npx tsc -p .`. Then `orca plugin release-entry plugins/gh-focus` from the
   root prints the catalog entry for `HEAD`: version, minimum Orca, capabilities, images.
3. **Open the release PR** `dev` → `main`, titled `release: vX.Y.Z`. Its body is the version's
   CHANGELOG section plus one `Closes #N` line per issue it finishes: closing keywords in PRs into
   `dev` do nothing, so issues done on `dev` close only here.
   ```sh
   gh pr create -R chimeyrock999/orca-github-plugins --base main --head dev \
     --title "release: vX.Y.Z" --body-file <file>
   ```
4. **Merge it with a merge commit.**
5. **Tag the merge commit and push the tag:**
   ```sh
   git fetch origin
   git tag -a vX.Y.Z -m vX.Y.Z origin/main
   git push origin vX.Y.Z
   ```
   The tag must match `version` in the manifest. Never move or delete a pushed tag.
6. **Publish a GitHub Release** for the tag, with the version's CHANGELOG section as notes:
   ```sh
   gh release create vX.Y.Z -R chimeyrock999/orca-github-plugins --verify-tag \
     --title "gh Focus X.Y.Z" --notes-file <file>
   ```
7. **Check the listing** at https://orca.dev/plugins/chimeyrock999/orca-github-plugins once Orca
   has picked the tag up, then install it from Settings → Plugins on an Orca without the dev copy
   loaded. Adding a capability, panel, command or event since the last release makes users
   approve the update again.

The first release also adds the topic, once:

```sh
gh repo edit chimeyrock999/orca-github-plugins --add-topic orca-plugin
```

## Hotfix

1. Branch `hotfix/<short-name>` from `main`, fix, and bump the patch version (`0.1.0` → `0.1.1`)
   with a CHANGELOG entry.
2. PR into `main`, merge with a merge commit, then tag and release as in steps 5 to 7.
3. Merge `main` back into `dev` (a PR `main` → `dev`, merge commit), so the fix and the version
   are not lost in the next release.

## Never change after the first release

- The id `gh-focus`: a new id is a new plugin, with a new approval and empty storage for users.
- The plugin's folder `plugins/gh-focus`: the catalog pins it as `source.path`, and moving it
  counts as a new repository.
- A pushed tag.
- The name and listing text must not suggest that GitHub or Orca made the plugin.

## Listing images

The icon (`images/icon.png`, `icon` in the manifest) is a flat 256×256 PNG: a git branch in a focus
frame, white on graphite, with nothing of GitHub's or Orca's marks. The catalog wants it square,
PNG or WEBP, static, at least 128×128 and at most 256 KB; `tests/manifest.test.ts` checks it.

Listing images (`images/issue.png`, also the cover, and `images/pull.png`) are screenshots of Orca
itself, in the dark theme, with the left sidebar collapsed. Capture the window without its shadow
(`screencapture -o -w <file>.png`), crop it to 16:10 from the left edge and scale it to 1600×1000,
then blur everything private: the folder path line under the repository name (it holds the home
directory), tab titles, and the text of the terminal or agent pane with its status line. Keep that
pane in the shot: "beside the code" means beside the work in progress, the agent or terminal
session next to the panel.

The catalog takes PNG, JPEG or WEBP; we keep PNG, which `tests/manifest.test.ts` checks: static, a
16:10 cover of at least 800×500 and at most 1024 KB, screenshots of at least 1280×800 and at most
1536 KB, six at most, 8 MB in all (`orca plugin validate` checks the limits too). Leave `theme`
unset on screenshots: a themed one hides from users of the other theme.
