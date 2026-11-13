// Forms of the Issues tab: edit the title and body, pick labels and assignees, and a new issue.
import { Badge, Box, Button, Checkbox, IconButton, Input, read, Row, Spinner, Stack, Text, Textarea, type OrcaNode } from 'orca'
import {
  addLogin,
  applyNewPicker,
  applyPicker,
  backToIssues,
  cancelEdit,
  changePicker,
  createIssue,
  newIssue,
  openNewPicker,
  saveEdit,
  setEditing,
  setNewIssue,
  togglePick,
  type IssueState,
  type Picking
} from './issue-store'
import { Problem } from './parts'
import type { IssueDetail } from './protocol'
import { choices } from './store'

/** Choices drawn at most, so a big org stays quick; the filter finds the rest. */
const SHOWN = 50

/** One line: the name in a fixed column, the values beside it, and a pencil when it can be edited. */
export function MetaLine({ label, empty, onEdit, children }: { label: string; empty: string; onEdit?: () => unknown; children?: OrcaNode }) {
  const values = [children].flat(3).filter((c) => c !== false && c !== null && c !== undefined)
  return (
    <Box direction="row" align="center" gap="sm">
      <Box width={72} shrink={false}>
        <Text size="xs" muted>
          {label}
        </Text>
      </Box>
      <Box grow minWidth={0} direction="row" gap="xs" wrap align="center">
        {values.length > 0 ? (
          children
        ) : (
          <Text size="sm" muted>
            {empty}
          </Text>
        )}
      </Box>
      {onEdit && <IconButton icon="edit" label={`Edit ${label.toLowerCase()}`} size="sm" variant="ghost" onPress={onEdit} />}
    </Box>
  )
}

/** Checkboxes over the repo's labels or assignable logins, with a filter; Apply sends the change. */
export function PickerBox({ where, picking, busy }: { where: 'issue' | 'new'; picking: Picking; busy: boolean }) {
  const c = read(choices)
  const known = picking.kind === 'labels' ? c.labels : c.assignees
  const query = picking.query.trim().toLowerCase()
  // What is picked shows even when the repo's list lacks it, such as a login typed in.
  const all = known === null ? picking.selected : [...picking.selected.filter((x) => !known.includes(x)), ...known]
  const matching = all.filter((x) => x.toLowerCase().includes(query))
  const noun = picking.kind === 'labels' ? 'labels' : 'people'
  return (
    <Box border radius="md" padding="sm" gap="sm">
      <Input
        label={`Filter ${noun}`}
        labelHidden
        type="search"
        placeholder={`Filter ${noun}`}
        value={picking.query}
        onChange={(value) => changePicker(where, (p) => ({ ...p, query: value }))}
      />
      <Box maxHeight={180} scroll="y" gap="xs">
        {known === null && <Spinner label={`Loading ${noun}`} />}
        {matching.slice(0, SHOWN).map((name) => (
          <Checkbox key={name} label={name} checked={picking.selected.includes(name)} onChange={(on) => togglePick(where, name, on)} />
        ))}
        {known !== null && matching.length === 0 && (
          <Text size="sm" muted>
            {`No ${noun} match.`}
          </Text>
        )}
        {matching.length > SHOWN && (
          <Text size="xs" muted>
            {`${matching.length - SHOWN} more: type to filter`}
          </Text>
        )}
      </Box>
      {picking.kind === 'assignees' && (
        <Input
          label="Add by login"
          placeholder="login, then Enter"
          value={picking.login}
          onChange={(value) => changePicker(where, (p) => ({ ...p, login: value }))}
          onSubmit={(value) => addLogin(where, value)}
        />
      )}
      <Row gap="xs" align="center">
        <Button size="sm" variant="solid" disabled={busy} onPress={where === 'issue' ? applyPicker : applyNewPicker}>
          Apply
        </Button>
        <Button size="sm" variant="ghost" onPress={() => changePicker(where, () => null)}>
          Cancel
        </Button>
        {busy && <Spinner label="Saving" labelHidden />}
      </Row>
    </Box>
  )
}

export function EditIssue({ d, s }: { d: IssueDetail; s: IssueState }) {
  const editing = s.editing!
  return (
    <Stack gap="sm">
      <Input label="Title" value={editing.title} invalid={!editing.title.trim()} onChange={(title) => setEditing({ title })} />
      {/* A body cut to fit the panel would lose its end if saved, so it is edited on GitHub. */}
      <Textarea label="Body" rows={10} value={editing.body} disabled={d.truncated} onChange={(body) => setEditing({ body })} />
      {d.truncated && (
        <Text size="xs" muted>
          This body is too long to edit here. Edit it on GitHub.
        </Text>
      )}
      <Row gap="xs" align="center">
        <Button size="sm" variant="solid" disabled={!editing.title.trim() || !!s.busy} onPress={saveEdit}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onPress={cancelEdit}>
          Cancel
        </Button>
        {s.busy === 'edit' && <Spinner label="Saving" labelHidden />}
      </Row>
    </Stack>
  )
}

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
        {n.picking?.kind === 'labels' && <PickerBox where="new" picking={n.picking} busy={false} />}
        <MetaLine label="Assignees" empty="No one" onEdit={() => openNewPicker('assignees')}>
          {n.assignees.length > 0 && <Text size="sm">{n.assignees.join(', ')}</Text>}
        </MetaLine>
        {n.picking?.kind === 'assignees' && <PickerBox where="new" picking={n.picking} busy={false} />}
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
