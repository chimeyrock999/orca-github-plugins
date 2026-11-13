// Pieces every view draws: a problem with its hint, and a state glyph.
import { Button, Callout, List, ListItem, Row, Stack, Text } from 'orca'
import { problemOf, type Look } from './look'
import type { PanelError } from './protocol'

/** The last folder of a path: the label of a choice whose project Orca does not name. */
function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

type Candidate = NonNullable<PanelError['candidates']>[number]

/** "<project> · <branch>", plus the folder name when another choice reads the same; the folder
 *  name alone when Orca names no project. */
function candidateTitle(c: Candidate, all: Candidate[]): string {
  if (!c.project) return folderName(c.path)
  const title = `${c.project} · ${c.branch}`
  const clash = all.some((o) => o !== c && o.project === c.project && o.branch === c.branch)
  return clash ? `${title} (${folderName(c.path)})` : title
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
  const problem = problemOf(error)
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
              <ListItem
                key={c.id}
                icon="folder"
                title={candidateTitle(c, error.candidates!)}
                description={c.path}
                onPress={() => onPick(c.path)}
              />
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

