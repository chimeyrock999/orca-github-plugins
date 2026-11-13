// The tabs' content: a list with its search, counts and pager, or one row in detail.
import {
  Badge,
  Box,
  Button,
  Callout,
  Code,
  EmptyState,
  IconButton,
  Input,
  KeyValue,
  List,
  ListItem,
  read,
  RelativeTime,
  Row,
  Select,
  shell,
  Skeleton,
  Stack,
  Text,
  Toolbar,
  type KeyValueItem
} from 'orca'
import { count, duration, issueLook, itemEvent, pageLine, problemOf, pullLook, runCause, runLook, type Look } from './look'
import { PAGE_SIZE, type IssueRow, type ItemSort, type PanelError, type PullRow, type RunRow } from './protocol'
import {
  back,
  choices,
  clearFilters,
  filterCount,
  lists,
  next,
  openRow,
  previous,
  rowKey,
  search,
  setDraft,
  setFilter,
  setSort,
  showState,
  toggleTool,
  type Kind,
  type ListState
} from './store'

const NAMES: Record<Kind, { plural: string; empty: string }> = {
  issues: { plural: 'issues', empty: 'No issues' },
  pulls: { plural: 'pull requests', empty: 'No pull requests' },
  runs: { plural: 'runs', empty: 'No workflow runs' }
}

/** The last folder of a path: what tells root clones on the same branch apart. */
function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

export function Problem({ error, onRetry, onPick }: { error: PanelError; onRetry?: () => unknown; onPick?: (path: string) => unknown }) {
  const problem = problemOf(error.code)
  return (
    <Callout tone={problem.tone} title={problem.title} icon="warning">
      <Stack gap="xs">
        <Text size="sm">{problem.hint}</Text>
        <Text size="xs" muted>
          {error.message}
        </Text>
        {error.candidates && onPick && (
          <List label="Workspaces">
            {error.candidates.map((c) => (
              <ListItem key={c.id} icon="folder" title={folderName(c.path)} description={c.path} onPress={() => onPick(c.path)} />
            ))}
          </List>
        )}
        {onRetry && (
          <Row>
            <Button size="sm" variant="outline" icon="refresh" onPress={onRetry}>
              Retry
            </Button>
          </Row>
        )}
      </Stack>
    </Callout>
  )
}

function Glyph({ look }: { look: Look }) {
  return (
    <Text tone={look.tone} size="md" weight="semibold">
      {look.glyph}
    </Text>
  )
}

function ItemMeta({ row }: { row: IssueRow | PullRow }) {
  const event = itemEvent(row)
  return (
    <Row gap="xs" wrap>
      {row.labels.map((label) => (
        <Badge key={label}>{label}</Badge>
      ))}
      <Text size="xs" muted>
        {`#${row.number}${row.author ? ` · ${row.author}` : ''} ${event.verb} `}
        <RelativeTime at={event.at} />
      </Text>
    </Row>
  )
}

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

function lookOf(kind: Kind, row: IssueRow | PullRow | RunRow): Look {
  if (kind === 'runs') return runLook(row as RunRow)
  return kind === 'pulls' ? pullLook(row as PullRow) : issueLook(row as IssueRow)
}

function RowItem({ kind, row }: { kind: Kind; row: IssueRow | PullRow | RunRow }) {
  return (
    <ListItem key={rowKey(row)} onPress={() => openRow(kind, rowKey(row))}>
      <Box direction="row" gap="md" align="center" paddingY="sm">
        <Glyph look={lookOf(kind, row)} />
        <Stack gap="xs">
          <Text weight="medium">{row.title}</Text>
          {kind === 'runs' ? <RunMeta row={row as RunRow} /> : <ItemMeta row={row as IssueRow | PullRow} />}
        </Stack>
      </Box>
    </ListItem>
  )
}

function Body({ kind, s }: { kind: Kind; s: ListState }) {
  if (s.answer === null) return <Skeleton lines={6} label={`Loading ${NAMES[kind].plural}`} />
  if (!s.answer.ok) return <Problem error={s.answer.error} onRetry={() => search(kind, s.query)} />
  if (s.answer.rows.length === 0) {
    return s.query ? (
      <EmptyState icon="search" title="No results" description={`Nothing matches ${s.query}.`} />
    ) : (
      <EmptyState icon="check" title={NAMES[kind].empty} description="Refresh to check again." />
    )
  }
  return (
    <List label={NAMES[kind].plural}>
      {s.answer.rows.map((row) => (
        <RowItem key={rowKey(row)} kind={kind} row={row} />
      ))}
    </List>
  )
}

function Counts({ kind, s }: { kind: Kind; s: ListState }) {
  const answer = s.answer?.ok ? s.answer : null
  if (kind === 'runs') {
    return (
      <Text size="sm" weight="semibold">
        {answer ? `${count(answer.total)} workflow runs` : 'Workflow runs'}
      </Text>
    )
  }
  const counts = s.counts
  // Button takes only text, so the count is a pill beside it; a placeholder holds its place while
  // the page loads, so the buttons do not jump.
  return (
    <Row gap="sm" align="center">
      {(['open', 'closed'] as const).map((state) => (
        <Row key={state} gap="xs" align="center">
          <Button size="sm" variant={s.state === state ? 'outline' : 'ghost'} onPress={() => showState(kind, state)}>
            {state === 'open' ? 'Open' : 'Closed'}
          </Button>
          {counts ? (
            <Badge>{count(counts[state] ?? 0)}</Badge>
          ) : s.answer === null ? (
            <Box width={28}>
              <Skeleton shape="text" lines={1} label={`Loading the ${state} count`} />
            </Box>
          ) : null}
        </Row>
      ))}
    </Row>
  )
}

const SORTS: { value: ItemSort; label: string }[] = [
  { value: 'created-desc', label: 'Newest' },
  { value: 'created-asc', label: 'Oldest' },
  { value: 'updated-desc', label: 'Recently updated' },
  { value: 'comments-desc', label: 'Most commented' }
]
const RUN_STATUSES = ['success', 'failure', 'in_progress', 'queued', 'cancelled', 'skipped', 'action_required']
const RUN_EVENTS = ['push', 'pull_request', 'schedule', 'workflow_dispatch', 'release', 'merge_group']
// Select options need a value; this one means "any".
const ANY = '*'

function Tools({ kind, s }: { kind: Kind; s: ListState }) {
  const count = filterCount(s)
  const sort = SORTS.find((o) => o.value === s.sort)?.label ?? 'Newest'
  return (
    <Toolbar label="List options" gap="xs">
      {count > 0 ? (
        <Button size="sm" variant={s.tool === 'filter' ? 'outline' : 'ghost'} icon="filter" tooltip={`Filters: ${count} on`} onPress={() => toggleTool(kind, 'filter')}>
          {count}
        </Button>
      ) : (
        <IconButton icon="filter" label="Filter" variant={s.tool === 'filter' ? 'outline' : 'ghost'} onPress={() => toggleTool(kind, 'filter')} />
      )}
      {kind !== 'runs' && (
        <IconButton icon="expand" label={`Sort: ${sort}`} variant={s.tool === 'sort' ? 'outline' : 'ghost'} onPress={() => toggleTool(kind, 'sort')} />
      )}
    </Toolbar>
  )
}

type Option = { value: string; label: string }
const asOptions = (values: string[] | null): Option[] | null => values && values.map((v) => ({ value: v, label: v }))

function Choice({ kind, s, name, label, options }: { kind: Kind; s: ListState; name: string; label: string; options: Option[] | null }) {
  return (
    <Select
      label={label}
      value={s.filters[name] || ANY}
      options={[{ value: ANY, label: options === null ? 'Loading...' : 'Any' }, ...(options ?? [])]}
      onChange={(value) => setFilter(kind, name, value === ANY ? '' : value)}
    />
  )
}

function Typed({ kind, s, name, label, placeholder }: { kind: Kind; s: ListState; name: string; label: string; placeholder: string }) {
  // The box shows the draft, so Clear filters empties it; the filter applies on Enter.
  return (
    <Input
      label={label}
      placeholder={placeholder}
      value={s.drafts[name] ?? ''}
      onChange={(value) => setDraft(kind, name, value)}
      onSubmit={(value) => setFilter(kind, name, value)}
    />
  )
}

function Strip({ kind, s }: { kind: Kind; s: ListState }) {
  const c = read(choices)
  if (s.tool === 'sort') {
    return (
      <Box border radius="md" padding="sm">
        <Select label="Sort" value={s.sort} options={SORTS} onChange={(value) => setSort(kind, value as ItemSort)} />
      </Box>
    )
  }
  return (
    <Box border radius="md" padding="sm" gap="sm" columns={2}>
      {kind === 'runs' ? (
        <>
          <Choice kind={kind} s={s} name="workflow" label="Workflow" options={c.workflows && c.workflows.map((w) => ({ value: String(w.id), label: w.name }))} />
          <Choice kind={kind} s={s} name="status" label="Status" options={asOptions(RUN_STATUSES)} />
          <Choice kind={kind} s={s} name="event" label="Event" options={asOptions(RUN_EVENTS)} />
          <Typed kind={kind} s={s} name="branch" label="Branch" placeholder="main" />
        </>
      ) : (
        <>
          <Typed kind={kind} s={s} name="author" label="Author" placeholder="login" />
          <Choice kind={kind} s={s} name="label" label="Label" options={asOptions(c.labels)} />
        </>
      )}
      {filterCount(s) > 0 && (
        <Row>
          <Button size="sm" variant="ghost" onPress={() => clearFilters(kind)}>
            Clear filters
          </Button>
        </Row>
      )}
    </Box>
  )
}

function Pager({ kind, s }: { kind: Kind; s: ListState }) {
  const answer = s.answer?.ok ? s.answer : null
  const page = s.cursors.length
  return (
    <Row justify="between" align="center">
      <Text size="xs" muted>
        {answer ? pageLine(page, answer.total, answer.limit, PAGE_SIZE) : `Page ${page}`}
      </Text>
      <Row gap="xs">
        <Button size="sm" variant="outline" disabled={page < 2 || s.answer === null} onPress={() => previous(kind)}>
          Previous
        </Button>
        <Button size="sm" variant="outline" disabled={!answer?.next} onPress={() => next(kind)}>
          Next
        </Button>
      </Row>
    </Row>
  )
}

// The list takes the panel's free height and scrolls inside, so the pager stays at the bottom.
function ListView({ kind, s }: { kind: Kind; s: ListState }) {
  return (
    <Box grow minHeight={0} gap="md">
      <Input
        label={`Search ${NAMES[kind].plural}`}
        labelHidden
        type="search"
        placeholder={kind === 'runs' ? 'Search runs: branch:main status:failure' : `Search ${NAMES[kind].plural}`}
        value={s.drafts.query ?? ''}
        onChange={(value) => setDraft(kind, 'query', value)}
        onSubmit={(value) => search(kind, value)}
      />
      <Row justify="between" align="center">
        <Counts kind={kind} s={s} />
        <Tools kind={kind} s={s} />
      </Row>
      {s.tool && <Strip kind={kind} s={s} />}
      <Box grow minHeight={0} scroll="y">
        <Body kind={kind} s={s} />
      </Box>
      <Pager kind={kind} s={s} />
    </Box>
  )
}

function at(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toLocaleString()
}

function details(kind: Kind, row: IssueRow | PullRow | RunRow): KeyValueItem[] {
  if (kind === 'runs') {
    const run = row as RunRow
    return [
      { label: 'Workflow', value: `${run.workflow} #${run.runNumber}` },
      { label: 'Started by', value: runCause(run) },
      { label: 'Branch', value: run.branch, code: true },
      { label: 'Commit', value: run.sha.slice(0, 7), code: true },
      { label: 'Started', value: at(run.startedAt) },
      { label: 'Duration', value: run.durationMs === null ? 'Running' : duration(run.durationMs) }
    ]
  }
  const item = row as IssueRow | PullRow
  const items: KeyValueItem[] = [
    { label: 'Author', value: item.author },
    { label: 'Labels', value: item.labels.join(', ') || 'None' }
  ]
  if ('branch' in item) items.push({ label: 'Branch', value: item.branch, code: true })
  items.push({ label: 'Opened', value: at(item.createdAt) })
  if ('mergedAt' in item && item.mergedAt) items.push({ label: 'Merged', value: at(item.mergedAt) })
  else if (item.closedAt) items.push({ label: 'Closed', value: at(item.closedAt) })
  return items
}

function Detail({ kind, row }: { kind: Kind; row: IssueRow | PullRow | RunRow }) {
  const look = lookOf(kind, row)
  return (
    <Stack gap="sm">
      <Row>
        <Button size="sm" variant="outline" onPress={() => back(kind)}>
          {`← Back to ${NAMES[kind].plural}`}
        </Button>
      </Row>
      {/* Heading level 3 draws as a small caps label; the title reads as a title. */}
      <Text size="md" weight="semibold">
        {row.title}
      </Text>
      <Row gap="xs" align="center">
        <Glyph look={look} />
        <Text size="sm" tone={look.tone}>
          {look.label}
        </Text>
        <Text size="sm" muted>
          {kind === 'runs' ? (row as RunRow).workflow : `#${(row as IssueRow).number}`}
        </Text>
      </Row>
      <KeyValue items={details(kind, row)} />
      <Row>
        <Button size="sm" icon="open-external" onPress={() => shell.openExternal(row.url)}>
          Open on GitHub
        </Button>
      </Row>
    </Stack>
  )
}

export function KindView({ kind }: { kind: Kind }) {
  const s = read(lists[kind])
  const row = s.open && s.answer?.ok ? s.answer.rows.find((r) => rowKey(r) === s.open) : undefined
  return row ? <Detail kind={kind} row={row} /> : <ListView kind={kind} s={s} />
}
