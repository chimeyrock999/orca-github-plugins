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
import { githubUrl, refresh, repo, requestFailed, selectTab, setRepo, tab, type Kind } from './store'
import { KindView, Problem } from './views'

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('repo.changed', (answer) => void setRepo(answer)))
  void plugin.request('repo.get').then(
    (answer) => setRepo(answer),
    (error: unknown) => setRepo(requestFailed(error))
  )
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
        <Problem error={r.error} onRetry={refresh} />
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
          <IconButton icon="refresh" label="Refresh" variant="ghost" onPress={refresh} />
          <IconButton icon="open-external" label="Open on GitHub" variant="ghost" onPress={openOnGitHub} />
        </Toolbar>
      </Row>
      <Tabs label="GitHub" value={read(tab)} onChange={(value) => selectTab(value as Kind)}>
        <Tab value="issues" label="Issues" icon="bug" />
        <Tab value="pulls" label="Pull requests" icon="branch" />
        <Tab value="runs" label="Actions" icon="play" />
      </Tabs>
      <KindView kind={read(tab)} />
    </Box>
  )
}

