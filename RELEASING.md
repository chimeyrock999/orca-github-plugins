# Releasing gh Focus

gh Focus ships through Orca's community catalog. There is no form and no review queue: Orca lists
any public repository with the `orca-plugin` topic and a `vX.Y.Z` tag whose plugin passes
`orca plugin validate` and the
[listing policy](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-listing-policy.md),
usually within an hour. The newest tag is pinned to its commit and content hash, and a listed
version never changes.

Commands below run from the repository root. The repository belongs to `chimeyrock999`, which may
not be the active `gh` account, so set its token for this shell (it does not switch the account
for other shells):

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
   - Know what users will be asked to approve. An update that asks for nothing new installs without
     asking. Orca asks again, and does not update by itself, when the release adds a capability,
     raises the execution profile, adds a command, shortcut, panel or event subscription, ships
     virtual machine recipes, or comes from a different repository (moving `plugins/gh-focus`
     counts). Compare the `capabilities` and `contributes` that step 2's `release-entry` prints with
     the last release's (`git checkout vPREV` and run it there), and say what is new in the
     CHANGELOG.
   - Add the release to the root `orca-catalog.json`. The indexer looks for `orca-plugin.json` only at
     the root or in one folder, so this file is what points it at `plugins/gh-focus` (without it,
     v0.1.0 was not listed). Commit the version bump first, run
     `orca plugin release-entry plugins/gh-focus` on that commit, and put its entry first in
     `releases` (newest first; keep the older ones), then `orca plugin validate orca-catalog.json`.
2. **Check `dev`** from `plugins/gh-focus/`: `orca plugin validate .`, `orca plugin test .`,
   `orca plugin check .`, `npx tsc -p .`. Then `orca plugin release-entry plugins/gh-focus` from the
   root prints the catalog entry for `HEAD`: version, minimum Orca, capabilities, contributions,
   images.
3. **Open the release PR** `dev` → `main`, titled `release: vX.Y.Z`. Its body is the version's
   CHANGELOG section plus one `Closes #N` line per issue it finishes: closing keywords in PRs into
   `dev` do nothing, so issues done on `dev` close only here.
   ```sh
   gh pr create -R chimeyrock999/orca-github-plugins --base main --head dev \
     --title "release: vX.Y.Z" --body-file <file>
   ```
4. **Merge it with a merge commit.**
5. **Check the merge commit, then tag it.** The tag is the one step that cannot be undone: once
   the topic is on, Orca lists it and refuses a moved tag. Tag the release PR's own merge commit,
   not whatever `main` points at, and check it first:
   ```sh
   sha=$(gh pr view <release PR> -R chimeyrock999/orca-github-plugins --json mergeCommit --jq .mergeCommit.oid)
   git fetch origin && git checkout --detach "$sha"
   grep '"version"' plugins/gh-focus/orca-plugin.json    # must say X.Y.Z
   orca plugin release-entry plugins/gh-focus            # version X.Y.Z, commit = $sha
   git tag -a vX.Y.Z -m vX.Y.Z "$sha"
   git push origin vX.Y.Z
   ```
   Never move or delete a pushed tag.
6. **The GitHub Release is created by the Release workflow** (`.github/workflows/release.yml`)
   when the tag is pushed, with the version's CHANGELOG section as notes. Before that it checks
   the tagged commit (`.github/release-check.mjs`): `version` equals the tag, the commit is on
   `main`, `CHANGELOG.md` has a `## X.Y.Z` section, and `orca-catalog.json` has the release, whose
   commit is in the tag's history. Watch the run in the repo's Actions tab. A red run leaves no
   Release, but the tag is already listed. When the run failed for a reason outside the tagged
   commit, run it again (Actions → Release → Run workflow, with the tag), or check and release by
   hand:
   ```sh
   node .github/release-check.mjs vX.Y.Z origin/main > notes.md &&
     gh release create vX.Y.Z -R chimeyrock999/orca-github-plugins --verify-tag \
       --title "gh Focus X.Y.Z" --notes-file notes.md
   ```
   The checks read the tagged commit, which cannot change: when one names a problem in it (as a
   missing catalog entry would have for 0.1.1), fix that on `dev` for the next release, and
   create this Release from the CHANGELOG section alone:
   ```sh
   node .github/release-check.mjs --notes-only vX.Y.Z > notes.md &&
     gh release create vX.Y.Z -R chimeyrock999/orca-github-plugins --verify-tag \
       --title "gh Focus X.Y.Z" --notes-file notes.md
   ```
7. **Check the listing** at https://orca.dev/plugins/chimeyrock999/orca-github-plugins once Orca
   has picked the tag up (usually within an hour). Then open the install link
   https://orca.dev/plugins/chimeyrock999.gh-focus?catalog=community and install from it, on an
   Orca without the dev copy loaded. Existing users get the release later than the listing shows
   it: automatic updates install a community release only once it has been listed for 12 hours,
   and never one that needs a new approval (step 1).

The first release also:

- adds the topic, once: `gh repo edit chimeyrock999/orca-github-plugins --add-topic orca-plugin`;
- after the install from the link works, drops "From the first release on" before the install link
  in both READMEs, in a PR into `dev`.

## Hotfix

1. Branch `hotfix/<short-name>` from `main`, fix, and bump the patch version (`0.1.0` → `0.1.1`)
   with a CHANGELOG entry and a new release in `orca-catalog.json` (step 1).
2. Run step 2's checks on the `hotfix/*` branch before its PR merges. A hotfix is the release most
   likely to be rushed.
3. PR into `main`, merge with a merge commit, then check, tag and release as in steps 5 to 7.
4. Merge `main` back into `dev` (a PR `main` → `dev`, merge commit), so the fix and the version
   are not lost in the next release.

## Never change after the first release

- The id `gh-focus`: a new id is a new plugin, with a new approval and empty storage for users.
- The plugin's folder `plugins/gh-focus`: the catalog pins it as `source.path`, and moving it
  counts as a new repository.
- A pushed tag.
- The root `orca-catalog.json` and its entry's id and `source.path`.
- The name and listing text must not suggest that GitHub or Orca made the plugin. Ids starting
  `orca-`, and the publishers `stablyai`, `official`, `anthropic`, `openai`, `github` or any
  starting `orca`, install only from Orca's official catalog.

## Listing images

The icon (`images/icon.png`, `icon` in the manifest) is a flat 256×256 PNG: a git branch in a focus
frame, white on graphite, with nothing of GitHub's or Orca's marks. The catalog wants it square,
PNG or WEBP, static, at least 128×128 and at most 256 KB; `tests/manifest.test.ts` checks it.

The cover (`images/cover.png`) and the README's animated cover (`docs/images/cover.webp`) are drawn
from `docs/cover/cover.html`, which places crops of the two screenshots (`docs/cover/issue.jpg`,
`pull.jpg`, the panel's 504 px on the right of each) beside the plugin's words. After retaking the
screenshots, crop them again and run `CHROME=<headless Chromium> docs/cover/render.sh` (needs
`img2webp`); it writes both.

The screenshots (`images/issue.png` and `images/pull.png`) are screenshots of Orca
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
