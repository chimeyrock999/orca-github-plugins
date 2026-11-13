// The tabs' content: on Actions a list with its search, filters and pager, or one run in detail; on
// Issues and Pull requests what Orca links to the workspace (src/linked-view.tsx), or one in detail.
import {
  Box,
  Button,
  Code,
  EmptyState,
  IconButton,
  Input,
  List,
  ListItem,
  read,
  RelativeTime,
  Row,
  Select,
  Skeleton,
  Stack,
  Text,
  Toolbar
} from 'orca'
import { count, duration, pageLine, runCause, runLook } from '../shared/look'
import { Glyph, Problem } from './parts'
import { issues } from './issues/issue-store'
import { IssueView } from './issues/issue-view'
import { LinkedView } from './linked/linked-view'
import { DISPATCH, openRun, startDispatch } from './runs/run-store'
import { DispatchView, Requested, RunView } from './runs/run-view'
import { PullsTab } from './pulls/pull-view'
import { PAGE_SIZE, type RunRow } from '../shared/protocol'
import { choices, clearFilters, filterCount, lists, next, previous, search, setDraft, setFilter, setScope, toggleTool, type Kind, type ListState } from './store'

function RunMeta({ row }: { row: RunRow }) {
  return (
    <Row gap="xs" wrap>
      <Text size="xs" muted>
        {`${row.workflow} #${row.runNumber}: ${runCause(row)}`}
      </Text>
      {row.branch && <Code>{row.branch}</Code>}
      <Text size="xs" muted>
        <RelativeTime at={row.startedAt} /> ·{' '}
        {row.durationMs === null ? <RelativeTime at={row.startedAt} format="duration" /> : duration(row.durationMs)}
      </Text>
    </Row>
  )
}

function RowItem({ row }: { row: RunRow }) {
  return (
    <ListItem onPress={() => openRun(row.id)}>
      <Box direction="row" gap="md" align="center" paddingY="sm">
        <Glyph look={runLook(row)} />
        <Stack gap="xs">
          <Text weight="medium">{row.title}</Text>
          <RunMeta row={row} />
        </Stack>
      </Box>
    </ListItem>
  )
}

function Body({ s }: { s: ListState }) {
  if (s.answer === null) return <Skeleton lines={6} label="Loading runs" />
  if (!s.answer.ok) return <Problem error={s.answer.error} onRetry={() => search('runs', s.query)} />
  if (s.answer.rows.length === 0) {
    return s.query ? (
      <EmptyState icon="search" title="No results" description={`Nothing matches ${s.query}.`} />
    ) : (
      <EmptyState icon="check" title="No workflow runs" description="Refresh to check again." />
    )
  }
  return (
    <List label="runs">
      {s.answer.rows.map((row) => (
        <RowItem key={row.id} row={row} />
      ))}
    </List>
  )
}

function Counts({ s }: { s: ListState }) {
  const answer = s.answer?.ok ? s.answer : null
  // The tab starts on the workspace's branch; every branch is one press away.
  const on = answer?.branch ?? null
  return (
    <Row gap="xs" align="center" wrap>
      <Text size="sm" weight="semibold">
        {answer ? `${count(answer.total)} ${on ? (answer.total === 1 ? 'run on' : 'runs on') : 'workflow runs'}` : 'Workflow runs'}
      </Text>
      {on && <Code>{on}</Code>}
      {s.scope === 'branch' && on && (
        <Button size="sm" variant="ghost" onPress={() => setScope('all')}>
          All branches
        </Button>
      )}
      {s.scope === 'all' && s.branch && (
        <Button size="sm" variant="ghost" onPress={() => setScope('branch')}>
          {`Only ${s.branch}`}
        </Button>
      )}
    </Row>
  )
}

const RUN_STATUSES = ['success', 'failure', 'in_progress', 'queued', 'cancelled', 'skipped', 'action_required']
const RUN_EVENTS = ['push', 'pull_request', 'schedule', 'workflow_dispatch', 'release', 'merge_group']
// Select options need a value; this one means "any".
const ANY = '*'

function Tools({ s }: { s: ListState }) {
  const count = filterCount(s)
  return (
    <Toolbar label="List options" gap="xs">
      {count > 0 ? (
        <Button size="sm" variant={s.tool ? 'outline' : 'ghost'} icon="filter" tooltip={`Filters: ${count} on`} onPress={() => toggleTool('runs')}>
          {count}
        </Button>
      ) : (
        <IconButton icon="filter" label="Filter" variant={s.tool ? 'outline' : 'ghost'} onPress={() => toggleTool('runs')} />
      )}
      <IconButton icon="play" label="Run workflow" variant="ghost" onPress={startDispatch} />
    </Toolbar>
  )
}

type Option = { value: string; label: string }
const asOptions = (values: string[]): Option[] => values.map((v) => ({ value: v, label: v }))

function Choice({ s, name, label, options }: { s: ListState; name: string; label: string; options: Option[] | null }) {
  return (
    <Select
      label={label}
      value={s.filters[name] || ANY}
      options={[{ value: ANY, label: options === null ? 'Loading...' : 'Any' }, ...(options ?? [])]}
      onChange={(value) => setFilter('runs', name, value === ANY ? '' : value)}
    />
  )
}

function Strip({ s }: { s: ListState }) {
  const c = read(choices)
  // The box shows the draft, so Clear filters empties it; the branch applies on Enter.
  return (
    <Box border radius="md" padding="sm" gap="sm" columns={2}>
      <Choice s={s} name="workflow" label="Workflow" options={c.workflows && c.workflows.map((w) => ({ value: String(w.id), label: w.name }))} />
      <Choice s={s} name="status" label="Status" options={asOptions(RUN_STATUSES)} />
      <Choice s={s} name="event" label="Event" options={asOptions(RUN_EVENTS)} />
      <Input
        label="Branch"
        placeholder="main"
        value={s.drafts.branch ?? ''}
        onChange={(value) => setDraft('runs', 'branch', value)}
        onSubmit={(value) => setFilter('runs', 'branch', value)}
      />
      {filterCount(s) > 0 && (
        <Row>
          <Button size="sm" variant="ghost" onPress={() => clearFilters('runs')}>
            Clear filters
          </Button>
        </Row>
      )}
    </Box>
  )
}

function Pager({ s }: { s: ListState }) {
  const answer = s.answer?.ok ? s.answer : null
  const page = s.cursors.length
  return (
    <Row justify="between" align="center">
      <Text size="xs" muted>
        {answer ? pageLine(page, answer.total, answer.limit, PAGE_SIZE) : `Page ${page}`}
      </Text>
      <Row gap="xs">
        <Button size="sm" variant="outline" disabled={page < 2 || s.answer === null} onPress={() => previous('runs')}>
          Previous
        </Button>
        <Button size="sm" variant="outline" disabled={!answer?.next} onPress={() => next('runs')}>
          Next
        </Button>
      </Row>
    </Row>
  )
}

// The list takes the panel's free height and scrolls inside, so the pager stays at the bottom.
function RunsList({ s }: { s: ListState }) {
  return (
    <Box grow minHeight={0} gap="md">
      <Input
        label="Search runs"
        labelHidden
        type="search"
        placeholder="Search runs: branch:main status:failure"
        value={s.drafts.query ?? ''}
        onChange={(value) => setDraft('runs', 'query', value)}
        onSubmit={(value) => search('runs', value)}
      />
      <Row justify="between" align="center">
        <Counts s={s} />
        <Tools s={s} />
      </Row>
      {s.tool && <Strip s={s} />}
      <Requested />
      <Box grow minHeight={0} scroll="y">
        <Body s={s} />
      </Box>
      <Pager s={s} />
    </Box>
  )
}

export function KindView({ kind }: { kind: Kind }) {
  const s = read(lists[kind])
  // Pull requests: the one open, else what Orca links to the workspace.
  if (kind === 'pulls') return <PullsTab />
  // An issue opens by number, so it shows whether or not it is in the linked list.
  if (kind === 'issues') return s.open ? <IssueView /> : <LinkedView t={issues} />
  // A run opens by id, so it shows while the page is loading again too.
  if (s.open) return s.open === DISPATCH ? <DispatchView /> : <RunView />
  return <RunsList s={s} />
}
