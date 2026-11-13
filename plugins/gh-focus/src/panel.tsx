// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  Box,
  EmptyState,
  Heading,
  IconButton,
  plugin,
  read,
  Row,
  shell,
  Skeleton,
  Stack,
  Tab,
  Tabs,
  Text,
  Toolbar,
  type PanelContext
} from 'orca'
import { issue, issues, newIssue } from './panel/issues/issue-store'
import { findPull, pull, pulls } from './panel/pulls/pull-store'
import { githubUrl, lists, loadChoices, pickRepo, refresh, repo, requestFailed, selectTab, setRepo, tab, unpickRepo, type Kind } from './panel/store'
import { Problem } from './panel/parts'
import { DISPATCH, loadForm, loadRun, progress, tabShown } from './panel/runs/run-store'
import { KindView } from './panel/views'

/** Runs `step`, then lets the tab on screen start on the workspace's issue or pull request if it
 *  has not yet (each thread starts only when its tab shows). */
async function thenStart(step: Promise<void> | void): Promise<void> {
  await step
  await issues.start()
  await findPull()
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('repo.changed', (answer) => void thenStart(setRepo(answer))))
  ctx.subscriptions.push(plugin.on('run.progress', ({ run }) => progress(run)))
  void plugin.request('repo.get').then(
    (answer) => thenStart(setRepo(answer)),
    (error: unknown) => setRepo(requestFailed(error))
  )
}

/** Refresh: the repo and the list, and the issue or pull request on screen. */
async function refreshAll(): Promise<void> {
  await thenStart(refresh())
  // Refresh drops the label and assignee choices; an open picker asks for its own again.
  const picking = read(issue).picking ?? read(newIssue).picking ?? read(pull).picking
  if (picking) void loadChoices(picking.kind)
  if (read(tab) === 'issues' && read(lists.issues).open === String(read(issue).number)) await issues.load()
  const run = read(lists.runs).open
  if (read(tab) === 'runs' && run === DISPATCH) await Promise.all([loadChoices('workflows'), loadForm()])
  else if (read(tab) === 'runs' && run) await loadRun()
  if (read(tab) !== 'pulls') return
  // The one on screen loads again; with none, the branch may have one by now.
  const shown = read(lists.pulls).open === String(read(pull).number)
  await findPull(true)
  if (shown) await pulls.load()
}

function openOnGitHub(): unknown {
  const url = githubUrl()
  return url ? shell.openExternal(url) : undefined
}

export default function Panel() {
  const r = read(repo)
  if (!r) return <Skeleton lines={3} label="Finding the repository" />
  if (!r.ok && r.error.code === 'no_workspace') {
    return <EmptyState icon="folder" title="No workspace focused" description="Focus a workspace in Orca to see its GitHub issues, pull requests and runs." />
  }
  if (!r.ok) {
    return (
      <Stack gap="md">
        <Heading level={3}>gh Focus</Heading>
        <Problem error={r.error} onRetry={refreshAll} onPick={(path) => thenStart(pickRepo(path))} />
      </Stack>
    )
  }
  // Tabs is only the tab bar: the tab's content sits beside it in the full-height column, so its
  // list can take the free height.
  return (
    <Box height="100%" gap="sm">
      <Row justify="between" align="center">
        <Stack gap="none">
          <Text weight="semibold">{r.nameWithOwner}</Text>
          <Text size="xs" muted truncate>
            {r.path}
          </Text>
        </Stack>
        <Toolbar label="Repository" gap="xs">
          {r.resolvedBy === 'picked' && (
            <IconButton icon="folder" label="Change workspace" variant="ghost" onPress={() => thenStart(unpickRepo())} />
          )}
          <IconButton icon="refresh" label="Refresh" variant="ghost" onPress={refreshAll} />
          <IconButton icon="open-external" label="Open on GitHub" variant="ghost" onPress={openOnGitHub} />
        </Toolbar>
      </Row>
      <Tabs
        label="GitHub"
        value={read(tab)}
        onChange={(value) => {
          const shown = thenStart(selectTab(value as Kind))
          return Promise.all([shown, tabShown()])
        }}
      >
        <Tab value="issues" label="Issues" icon="bug" />
        <Tab value="pulls" label="Pull requests" icon="branch" />
        <Tab value="runs" label="Actions" icon="play" />
      </Tabs>
      <KindView kind={read(tab)} />
    </Box>
  )
}

