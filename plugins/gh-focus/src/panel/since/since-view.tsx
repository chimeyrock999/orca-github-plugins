// The "Since you were here" block above the tabs: the linked items that changed and the branch's
// runs that finished while the person was away, each line pressable, with Dismiss.
import { Badge, Box, Button, Code, List, ListItem, read, RelativeTime, Row, Stack, Text } from 'orca'
import { endedWords, runLook, sinceLook, sinceWords } from '../../shared/look'
import { Glyph } from '../parts'
import { repo } from '../store'
import { dismissSince, openSinceItem, openSinceRun, showAllSince, since, SINCE_LINES } from './since-store'
import type { RunRow, SinceItem } from '../../shared/protocol'

function ItemLine({ item, viewer }: { item: SinceItem; viewer: string | null }) {
  return (
    <ListItem onPress={() => openSinceItem(item)}>
      <Box direction="row" gap="md" align="center" paddingY="xs">
        <Glyph look={sinceLook(item)} />
        <Stack gap="none">
          <Row gap="xs" align="center">
            {item.repo && <Badge>{item.repo}</Badge>}
            <Text size="sm" weight="medium" truncate>{`#${item.number} ${item.title}`}</Text>
          </Row>
          <Text size="xs" muted>
            {sinceWords(item, viewer)}
          </Text>
        </Stack>
      </Box>
    </ListItem>
  )
}

function RunLine({ row }: { row: RunRow }) {
  return (
    <ListItem onPress={() => openSinceRun(row.id)}>
      <Box direction="row" gap="md" align="center" paddingY="xs">
        <Glyph look={runLook(row)} />
        <Stack gap="none">
          <Text size="sm" weight="medium" truncate>{`${row.workflow} #${row.runNumber}`}</Text>
          <Row gap="xs" align="center" wrap>
            <Text size="xs" muted>{`${endedWords(row)} on`}</Text>
            {row.branch && <Code>{row.branch}</Code>}
            <Text size="xs" muted>
              {'· '}
              <RelativeTime at={row.startedAt + (row.durationMs ?? 0)} />
            </Text>
          </Row>
        </Stack>
      </Box>
    </ListItem>
  )
}

export function SinceBlock() {
  const s = read(since)
  const r = read(repo)
  // Only for the workspace it was asked in: another one's waits for its own answer.
  if (!s || !r?.ok || s.where !== r.workspaceId) return null
  const { items, runs, viewer, skipped } = s.answer
  const lines = [...items.map((item) => ({ key: `${item.repo ?? ''}#${item.number}`, item })), ...runs.map((row) => ({ key: `run ${row.id}`, row }))]
  const shown = s.all ? lines : lines.slice(0, SINCE_LINES)
  const rest = lines.length - shown.length
  return (
    <Box border radius="md" padding="sm" gap="xs">
      <Row justify="between" align="center" wrap>
        <Row gap="xs" align="center">
          <Text size="sm" weight="semibold">
            Since you were here
          </Text>
          <Text size="xs" muted>
            {'· left '}
            <RelativeTime at={s.answer.since} />
          </Text>
        </Row>
        <Button size="sm" variant="ghost" onPress={dismissSince}>
          Dismiss
        </Button>
      </Row>
      <List label="Since you were here">
        {shown.map((line) => ('item' in line ? <ItemLine key={line.key} item={line.item!} viewer={viewer} /> : <RunLine key={line.key} row={line.row!} />))}
      </List>
      {rest > 0 && (
        <Row>
          <Button size="sm" variant="ghost" onPress={showAllSince}>
            {`and ${rest} more`}
          </Button>
        </Row>
      )}
      {skipped && (
        <Text size="xs" muted>
          Comments and reviews skipped while the GitHub budget is low.
        </Text>
      )}
    </Box>
  )
}
