// Pieces every view draws: a problem with its hint, and a state glyph.
import { Button, Callout, List, ListItem, Row, Stack, Text } from 'orca'
import { problemOf, type Look } from './look'
import type { PanelError } from './protocol'

/** The last folder of a path: what tells root clones on the same branch apart. */
function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

export function Problem({
  error,
  onRetry,
  onPick,
  retryLabel = 'Retry'
}: {
  error: PanelError
  onRetry?: () => unknown
  onPick?: (path: string) => unknown
  /** `Dismiss` for a failed write, where pressing again would repeat it. */
  retryLabel?: string
}) {
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
            <Button size="sm" variant="outline" icon={retryLabel === 'Retry' ? 'refresh' : 'close'} onPress={onRetry}>
              {retryLabel}
            </Button>
          </Row>
        )}
      </Stack>
    </Callout>
  )
}

export function Glyph({ look }: { look: Look }) {
  return (
    <Text tone={look.tone} size="md" weight="semibold">
      {look.glyph}
    </Text>
  )
}

