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
import { issue, loadIssue, newIssue, startIssues } from './issue-store'
import { githubUrl, lists, loadChoices, pickRepo, refresh, repo, requestFailed, selectTab, setRepo, tab, unpickRepo, type Kind } from './store'
import { Problem } from './parts'
import { DISPATCH, loadForm, loadRun, progress } from './run-store'
import { KindView } from './views'

/** Runs `step`, then lets the Issues tab start on the workspace's issue if it has not yet. */
async function thenIssues(step: Promise<void> | void): Promise<void> {
  await step
  await startIssues()
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('repo.changed', (answer) => void thenIssues(setRepo(answer))))
  ctx.subscriptions.push(plugin.on('run.progress', ({ run }) => progress(run)))
  void plugin.request('repo.get').then(
    (answer) => thenIssues(setRepo(answer)),
    (error: unknown) => setRepo(requestFailed(error))
  )
}

/** Refresh: the repo and the list, and the issue on screen. */
async function refreshAll(): Promise<void> {
  await thenIssues(refresh())
  // Refresh drops the label and assignee choices; an open picker asks for its own again.
  const picking = read(issue).picking ?? read(newIssue).picking
  if (picking) void loadChoices(picking.kind)
  const open = read(lists.issues).open
  if (read(tab) === 'issues' && open === String(read(issue).number)) await loadIssue()
  const run = read(lists.runs).open
  if (read(tab) === 'runs' && run === DISPATCH) await Promise.all([loadChoices('workflows'), loadForm()])
  else if (read(tab) === 'runs' && run) await loadRun()
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
        <Heading level={3}>GitHub</Heading>
        <Problem error={r.error} onRetry={refreshAll} onPick={(path) => thenIssues(pickRepo(path))} />
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
            <IconButton icon="folder" label="Change workspace" variant="ghost" onPress={() => thenIssues(unpickRepo())} />
          )}
          <IconButton icon="refresh" label="Refresh" variant="ghost" onPress={refreshAll} />
          <IconButton icon="open-external" label="Open on GitHub" variant="ghost" onPress={openOnGitHub} />
        </Toolbar>
      </Row>
      <Tabs label="GitHub" value={read(tab)} onChange={(value) => thenIssues(selectTab(value as Kind))}>
        <Tab value="issues" label="Issues" icon="bug" />
        <Tab value="pulls" label="Pull requests" icon="branch" />
        <Tab value="runs" label="Actions" icon="play" />
      </Tabs>
      <KindView kind={read(tab)} />
    </Box>
  )
}

