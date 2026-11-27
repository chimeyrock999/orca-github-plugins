// Pieces every view draws: a problem with its hint, and a state glyph.
import { Box, Button, Callout, Row, Stack, Text } from 'orca'
import { problemOf, type Look } from '../shared/look'
import type { PanelError } from '../shared/protocol'

export function Problem({
  error,
  onRetry,
  retryLabel = 'Retry'
}: {
  error: PanelError
  onRetry?: () => unknown
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

/** The width of a glyph's slot; a line that starts under a glyph's text skips as much. */
export const GLYPH_WIDTH = 16

/** A state glyph centered in a fixed slot: glyphs differ in width (✓ is narrow, ◉ wide), so the
 *  text beside a column of them lines up and a narrow one keeps clear of it. */
export function Glyph({ look }: { look: Look }) {
  return (
    // A Box is a column: `align` centers the glyph across the slot.
    <Box width={GLYPH_WIDTH} align="center" shrink={false}>
      <Text tone={look.tone} size="md" weight="semibold">
        {look.glyph}
      </Text>
    </Box>
  )
}

