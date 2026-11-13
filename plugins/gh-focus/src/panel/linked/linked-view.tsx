// The Issues and Pull requests tabs with no thread open: the items Orca links to the workspace, or,
// with none, how to link one (the command, or asking the workspace's agent), and the hand-offs.
import { Badge, Box, Button, Callout, Code, EmptyState, List, ListItem, read, RelativeTime, Row, shell, Skeleton, Stack, Text } from 'orca'
import { askAgent, agentNow, dismissHandOff, handOff, handOffError, showCommand } from './link-store'
import { linkCommand, linkedLook } from '../../shared/look'
import { Glyph, Problem } from '../parts'
import { LINKED_LIMIT, type LinkedKind, type LinkedRow } from '../../shared/protocol'
import { repo } from '../store'
import type { AnyThread, LinkedState } from '../thread/thread-store'

const NOUN: Record<LinkedKind, { one: string; many: string }> = {
  issues: { one: 'issue', many: 'issues' },
  pulls: { one: 'pull request', many: 'pull requests' }
}

export function HandOffProblem() {
  const error = read(handOffError)
  return error ? <Problem error={error} onRetry={dismissHandOff} retryLabel="Dismiss" /> : null
}

/** Tasks: Orca's own page lists, searches and filters the repo's issues and pull requests. At the
 *  top right of a tab it reads as the way out to it (`top`). */
export function TasksButton({ kind, top = false }: { kind: LinkedKind; top?: boolean }) {
  return (
    <Button size="sm" variant="outline" icon={top ? undefined : 'layers'} tooltip={`Orca's Tasks page: every ${NOUN[kind].one} of the repo`} onPress={() => handOff('tasks')}>
      {top ? 'Orca Tasks →' : 'Tasks'}
    </Button>
  )
}

/** The top of an open issue or pull request: Back (when there is one) on the left, Orca Tasks on the
 *  right, with a little room above and below; a narrow sidebar wraps them onto two lines. */
export function ThreadTop({ kind, back, onBack }: { kind: LinkedKind; back: string | null; onBack: () => unknown }) {
  return (
    <Box paddingY="xs">
      <Row justify={back ? 'between' : 'end'} align="center" wrap>
        {back && (
          <Button size="sm" variant="outline" onPress={onBack}>
            {back}
          </Button>
        )}
        <TasksButton kind={kind} top />
      </Row>
    </Box>
  )
}

function LinkedItem({ t, row }: { t: AnyThread; row: LinkedRow }) {
  // One of another repo opens here too, read and written in its own repo; the badge names it.
  return (
    <ListItem onPress={() => t.open(row.number, row.repo)}>
      <Box direction="row" gap="md" align="center" paddingY="sm">
        <Glyph look={linkedLook(t.kind, row)} />
        <Stack gap="xs">
          <Text weight="medium">{row.title}</Text>
          <Row gap="xs" align="center" wrap>
            {row.repo && <Badge>{row.repo}</Badge>}
            <Text size="xs" muted>
              {`#${row.number}`}
              {row.author && ` by ${row.author}`}
              {row.updatedAt !== null && (
                <>
                  {' · updated '}
                  <RelativeTime at={row.updatedAt} />
                </>
              )}
            </Text>
          </Row>
        </Stack>
      </Box>
    </ListItem>
  )
}

function LinkedList({ t, l }: { t: AnyThread; l: LinkedState }) {
  const n = l.refs?.length ?? 0
  const noun = n === 1 ? NOUN[t.kind].one : NOUN[t.kind].many
  return (
    <Box grow minHeight={0} gap="sm">
      <Row justify="end">
        <TasksButton kind={t.kind} top />
      </Row>
      <Text size="sm" weight="semibold">{`${n} linked ${noun}`}</Text>
      <HandOffProblem />
      <Box grow minHeight={0} scroll="y">
        {l.rows === null ? (
          <Skeleton lines={3} label={`Loading the linked ${NOUN[t.kind].many}`} />
        ) : !l.rows.ok ? (
          <Problem error={l.rows.error} onRetry={t.loadRows} />
        ) : (
          <List label={`Linked ${NOUN[t.kind].many}`}>
            {l.rows.rows.map((row) => (
              <LinkedItem key={`${row.repo ?? ''}#${row.number}`} t={t} row={row} />
            ))}
          </List>
        )}
      </Box>
      <Text size="xs" muted>
        {`${n > LINKED_LIMIT ? `Showing the first ${LINKED_LIMIT}. ` : ''}Only what Orca links to this workspace. Tasks lists the whole repo.`}
      </Text>
    </Box>
  )
}

/** How to link one: the command, and the workspace's free agent to ask, if any. */
function HowToLink({ kind }: { kind: LinkedKind }) {
  const r = read(repo)
  const a = agentNow()
  const noun = NOUN[kind].one
  if (a?.asked === kind) {
    return (
      <Callout tone="success" title={`Typed into ${a.agent?.name ?? 'the agent'}`}>
        <Stack gap="xs">
          <Text size="sm">{`Read it in the agent's terminal and press Enter there. Once the ${noun} is linked, Refresh opens it.`}</Text>
          <Row>
            <Button size="sm" variant="ghost" onPress={showCommand}>
              Show the command again
            </Button>
          </Row>
        </Stack>
      </Callout>
    )
  }
  return (
    <Box border radius="md" padding="sm" gap="sm">
      <Text size="sm" weight="semibold">
        Link one
      </Text>
      {r?.ok && <Code block>{linkCommand(r.url, kind)}</Code>}
      {a === null ? (
        <Skeleton lines={1} label="Looking for a free agent" />
      ) : a.agent ? (
        <>
          <Text size="xs" muted>{`Or ask the workspace's agent: it knows which ${noun} it is working on.`}</Text>
          <Row>
            <Button size="sm" variant="outline" icon="agent" disabled={a.asking} onPress={() => askAgent(kind)}>
              {a.asking ? 'Asking…' : `Ask ${a.agent.name} to link`}
            </Button>
          </Row>
        </>
      ) : (
        <Text size="xs" muted>
          No agent is free in this workspace to ask. Run the command in a terminal of the workspace.
        </Text>
      )}
      {a?.error && <Problem error={a.error} onRetry={showCommand} retryLabel="Dismiss" />}
    </Box>
  )
}

/** Nothing linked of this kind (and, on Pull requests, no pull request for the branch either). */
function NoneLinked({ kind }: { kind: LinkedKind }) {
  const r = read(repo)
  const pulls = kind === 'pulls'
  return (
    <Box grow minHeight={0} scroll="y" gap="md">
      <EmptyState
        icon="link"
        title={pulls ? 'No pull request for this workspace' : 'No issue linked to this workspace'}
        description={pulls ? 'Orca links none, and the branch has no pull request on GitHub.' : `Orca links no issue of ${r?.ok ? r.nameWithOwner : 'this repo'} to it.`}
      />
      <HowToLink kind={kind} />
      <Row gap="xs" justify="center">
        <TasksButton kind={kind} />
        <Button size="sm" variant="outline" icon="open-external" onPress={() => (r?.ok ? shell.openExternal(`${r.url}/${kind}`) : undefined)}>
          Open on GitHub
        </Button>
      </Row>
      <Row justify="center">
        <Text size="xs" muted>
          Tasks opens with the repo Orca has selected there.
        </Text>
      </Row>
      <HandOffProblem />
    </Box>
  )
}

/** The tab with no thread open: still asking Orca, nothing linked, or the linked list. */
export function LinkedView({ t }: { t: AnyThread }) {
  const l = t.linkedNow()
  if (!l || l.refs === null) return <Skeleton lines={4} label={`Finding this workspace's ${NOUN[t.kind].many}`} />
  if (l.refs.length === 0) return <NoneLinked kind={t.kind} />
  return <LinkedList t={t} l={l} />
}

/** What Back says on a thread: to the workspace's only link, to the linked list, or to the empty
 *  state; null on the only link itself. */
export function backLabel(t: AnyThread): string | null {
  const one = t.sole()
  if (one) return t.isShown(one) ? null : `← Back to ${one.repo ?? ''}#${one.number}`
  return t.linkedNow()?.refs?.length ? `← Back to linked ${NOUN[t.kind].many}` : '← Back'
}
