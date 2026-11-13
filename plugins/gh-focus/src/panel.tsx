// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  Box,
  Callout,
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
import { issue, issues } from './panel/issues/issue-store'
import { findAgent } from './panel/linked/link-store'
import { pull, pulls } from './panel/pulls/pull-store'
import { budget, budgetAnswered, budgetChanged, githubUrl, itemKey, lists, loadChoices, pickRepo, refresh, repo, requestFailed, selectTab, setRepo, tab, unpickRepo, type Kind } from './panel/store'
import { Problem } from './panel/parts'
import { DISPATCH, loadForm, loadRun, progress, tabShown } from './panel/runs/run-store'
import { KindView } from './panel/views'
import { budgetWords } from './shared/look'

/** Runs `step`, then lets the tab on screen ask Orca what it links to the workspace if it has not
 *  yet (each tab starts only when it shows); with nothing linked, a free agent is looked for. */
async function thenStart(step: Promise<void> | void, again = false): Promise<void> {
  await step
  await issues.start(again)
  await pulls.start(again)
  await agentIfNone(again)
}

/** The empty state offers a free agent to ask; it is looked for only when that state shows. */
async function agentIfNone(again: boolean): Promise<void> {
  const kind = read(tab)
  if (kind === 'runs' || read(lists[kind]).open) return
  const t = kind === 'issues' ? issues : pulls
  if (t.linkedNow()?.refs?.length === 0) await findAgent(again)
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('repo.changed', (answer) => void thenStart(setRepo(answer))))
  ctx.subscriptions.push(plugin.on('run.progress', ({ run }) => progress(run)))
  ctx.subscriptions.push(plugin.on('budget.changed', (answer) => budgetChanged(answer.budget)))
  void plugin.request('budget.get').then(
    (answer) => answer.ok && budgetAnswered(answer.budget),
    () => undefined
  )
  void plugin.request('repo.get').then(
    (answer) => thenStart(setRepo(answer)),
    (error: unknown) => setRepo(requestFailed(error))
  )
}

/** Refresh: the repo, the list or what Orca links to the workspace (something may be linked by now,
 *  or the branch have a pull request), and the issue, pull request or run on screen. */
async function refreshAll(): Promise<void> {
  const shown = (kind: 'issues' | 'pulls') => {
    const s = kind === 'issues' ? read(issue) : read(pull)
    return read(lists[kind]).open === itemKey(s.number, s.repo)
  }
  const was = { issues: shown('issues'), pulls: shown('pulls') }
  await thenStart(refresh(), true)
  // Refresh drops the label and assignee choices; an open picker asks for its own again.
  const picking = read(issue).picking ?? read(pull).picking
  if (picking) void loadChoices(picking.kind, picking.of)
  if (read(tab) === 'issues' && was.issues && shown('issues')) await issues.load()
  if (read(tab) === 'pulls' && was.pulls && shown('pulls')) await pulls.load()
  const run = read(lists.runs).open
  if (read(tab) === 'runs' && run === DISPATCH) await Promise.all([loadChoices('workflows'), loadForm()])
  else if (read(tab) === 'runs' && run) await loadRun()
}

function openOnGitHub(): unknown {
  const url = githubUrl()
  return url ? shell.openExternal(url) : undefined
}

/** The GitHub budget the panel shares with Orca, while it is low. */
function BudgetLow() {
  const b = read(budget)
  if (!b) return null
  return (
    <Callout tone="warning" title="GitHub budget low" icon="warning">
      <Text size="sm">{budgetWords(b)}</Text>
    </Callout>
  )
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
      <BudgetLow />
      <Tabs
        label="GitHub"
        value={read(tab)}
        onChange={(value) => {
          const shown = thenStart(selectTab(value as Kind))
          return Promise.all([shown, tabShown()])
        }}
      >
        <Tab value="issues" label="Issues" />
        <Tab value="pulls" label="Pull requests" />
        <Tab value="runs" label="Actions" />
      </Tabs>
      <KindView kind={read(tab)} />
    </Box>
  )
}

