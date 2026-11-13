// The new issue form of the Issues tab.
import { Badge, Box, Button, Input, read, Row, Spinner, Text, Textarea } from 'orca'
import { backToIssues, createIssue, newIssue, newPicker, openNewPicker, setNewIssue } from './issue-store'
import { Problem } from './parts'
import { MetaLine, PickerBox } from './thread-view'

export function NewIssueView() {
  const n = read(newIssue)
  return (
    <Box grow minHeight={0} gap="sm">
      <Row>
        <Button size="sm" variant="outline" onPress={backToIssues}>
          ← Back to issues
        </Button>
      </Row>
      <Box grow minHeight={0} scroll="y" gap="md">
        <Text size="md" weight="semibold">
          New issue
        </Text>
        <Input label="Title" placeholder="Title" value={n.title} onChange={(title) => setNewIssue({ title })} />
        <Textarea label="Body" placeholder="Describe the issue (Markdown)" rows={8} value={n.body} onChange={(body) => setNewIssue({ body })} />
        <MetaLine label="Labels" empty="None" onEdit={() => openNewPicker('labels')}>
          {n.labels.map((l) => (
            <Badge key={l}>{l}</Badge>
          ))}
        </MetaLine>
        {n.picking?.kind === 'labels' && <PickerBox ops={newPicker} picking={n.picking} busy={false} />}
        <MetaLine label="Assignees" empty="No one" onEdit={() => openNewPicker('assignees')}>
          {n.assignees.length > 0 && <Text size="sm">{n.assignees.join(', ')}</Text>}
        </MetaLine>
        {n.picking?.kind === 'assignees' && <PickerBox ops={newPicker} picking={n.picking} busy={false} />}
        {n.error && <Problem error={n.error} />}
        <Row gap="xs" align="center">
          <Button size="sm" variant="solid" disabled={!n.title.trim() || n.busy} onPress={createIssue}>
            Create issue
          </Button>
          <Button size="sm" variant="ghost" onPress={backToIssues}>
            Cancel
          </Button>
          {n.busy && <Spinner label="Creating" labelHidden />}
        </Row>
      </Box>
    </Box>
  )
}
