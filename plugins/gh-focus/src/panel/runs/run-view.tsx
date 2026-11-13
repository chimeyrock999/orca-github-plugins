// The Actions tab past the list: one run with its jobs, steps and logs, its writes, and the Run
// workflow form.
import {
  Box,
  Button,
  Callout,
  CodeView,
  Collapsible,
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
  Spinner,
  Stack,
  Switch,
  Text,
  type KeyValueItem
} from 'orca'
import { count, duration, localTime, runCause, runLook } from '../look'
import { Glyph, Problem } from '../parts'
import type { DispatchInput, LogStep, RunDetail, RunJob, RunLogs } from '../../shared/protocol'
import {
  addRow,
  askCancel,
  backToRuns,
  cancelRun,
  dismissError,
  dispatch,
  forgetRequested,
  leaveDispatch,
  loadForm,
  loadLogs,
  loadRun,
  missing,
  pickWorkflow,
  refChanged,
  requested,
  rerun,
  resumeLive,
  runView,
  runWorkflow,
  setRef,
  setRow,
  setValue,
  settled,
  toggleJob,
  toggleStep,
  type DispatchState,
  type LogView,
  type OpenRun
} from './run-store'
import { choices } from '../store'

function details(run: RunDetail): KeyValueItem[] {
  return [
    { label: 'Started by', value: runCause(run) },
    { label: 'Branch', value: run.branch, code: true },
    { label: 'Commit', value: run.sha.slice(0, 7), code: true },
    { label: 'Started', value: localTime(run.startedAt) },
    { label: 'Duration', value: run.durationMs !== null ? duration(run.durationMs) : run.state === 'queued' ? 'Not started' : 'Running' }
  ]
}

function Live({ s, run }: { s: OpenRun; run: RunDetail }) {
  if (settled(s)) return null
  if (s.liveError) {
    return (
      <Row gap="xs" align="center" wrap>
        <Text size="xs" muted>{`Live updates stopped: ${s.liveError.message}`}</Text>
        <Button size="sm" variant="ghost" icon="refresh" onPress={resumeLive}>
          Resume
        </Button>
      </Row>
    )
  }
  return (
    <Row gap="xs" align="center">
      <Spinner label="Live" labelHidden />
      <Text size="xs" muted>
        {run.attempt < s.awaitAttempt ? `Starting attempt ${s.awaitAttempt} · updated ` : 'Live · updated '}
        <RelativeTime at={s.updatedAt ?? Date.now()} />
      </Text>
    </Row>
  )
}

function Actions({ s, run }: { s: OpenRun; run: RunDetail }) {
  if (s.confirmCancel) {
    return (
      <Callout tone="warning" title={`Cancel run ${run.workflow} #${run.runNumber}?`}>
        <Stack gap="sm">
          <Text size="sm">Jobs still running stop now. You can rerun it later.</Text>
          <Row gap="xs">
            <Button size="sm" variant="solid" tone="danger" disabled={!!s.busy} onPress={cancelRun}>
              Cancel run
            </Button>
            <Button size="sm" variant="ghost" onPress={() => askCancel(false)}>
              Keep running
            </Button>
            {s.busy === 'cancel' && <Spinner label="Cancelling" labelHidden />}
          </Row>
        </Stack>
      </Callout>
    )
  }
  // A re-run that GitHub has not started yet: nothing to cancel or re-run until it shows.
  if (run.attempt < s.awaitAttempt) return null
  if (!run.done) {
    return (
      <Row>
        <Button size="sm" variant="outline" onPress={() => askCancel(true)}>
          Cancel run…
        </Button>
      </Row>
    )
  }
  const failed = run.jobs.some((j) => j.state === 'failure' || j.state === 'cancelled')
  return (
    <Row gap="xs" align="center" wrap>
      {failed && (
        <Button size="sm" variant="outline" disabled={!!s.busy} onPress={() => rerun(true)}>
          Rerun failed jobs
        </Button>
      )}
      <Button size="sm" variant="outline" disabled={!!s.busy} onPress={() => rerun(false)}>
        Rerun all jobs
      </Button>
      {s.busy && <Spinner label="Rerunning" labelHidden />}
    </Row>
  )
}

/** gh reads the logs of a finished run only. */
function Steps({ job, done }: { job: RunJob; done: boolean }) {
  return (
    <Box paddingX="md" paddingY="xs" gap="xs" background="muted" radius="sm">
      {job.steps.length === 0 && (
        <Text size="xs" muted>
          {job.stepsCut ? 'Steps are left out of a run this big; the log has them.' : 'No steps yet.'}
        </Text>
      )}
      {job.steps.map((step) => {
        const look = runLook(step)
        return (
          <Row key={step.number} gap="sm" align="center">
            <Text size="sm" tone={look.tone} weight="semibold">
              {look.glyph}
            </Text>
            <Box grow minWidth={0}>
              <Text size="sm" truncate>
                {step.name}
              </Text>
            </Box>
            <Text size="xs" muted>
              {step.durationMs === null ? '' : duration(step.durationMs)}
            </Text>
          </Row>
        )
      })}
      <Row gap="xs" wrap>
        {done && (
          <Button size="sm" variant="outline" onPress={() => loadLogs(job.id)}>
            View log
          </Button>
        )}
        <Button size="sm" variant="ghost" icon="open-external" onPress={() => shell.openExternal(job.url)}>
          Log on GitHub
        </Button>
      </Row>
    </Box>
  )
}

function Jobs({ s, run }: { s: OpenRun; run: RunDetail }) {
  const passed = run.jobs.filter((j) => j.state === 'success').length
  return (
    <Stack gap="xs">
      <Row justify="between" align="center">
        <Text size="sm" weight="semibold">
          Jobs
        </Text>
        <Text size="xs" muted>
          {run.jobs.length ? `${passed} of ${run.jobs.length} succeeded` : ''}
        </Text>
      </Row>
      {run.jobs.length === 0 ? (
        <Text size="sm" muted>
          This run has no jobs. It may have failed before any started; open it on GitHub to see why.
        </Text>
      ) : (
        run.jobs.map((job) => (
          <Stack key={job.id} gap="xs">
            <List label={job.name}>
              <ListItem onPress={() => toggleJob(job.id)} current={s.openJob === job.id}>
                <Box direction="row" gap="sm" align="center">
                  <Glyph look={runLook(job)} />
                  <Box grow minWidth={0}>
                    <Text size="sm" weight="medium" truncate>
                      {job.name}
                    </Text>
                  </Box>
                  <Text size="xs" muted>
                    {job.durationMs === null ? runLook(job).label : duration(job.durationMs)}
                  </Text>
                </Box>
              </ListItem>
            </List>
            {s.openJob === job.id && <Steps job={job} done={run.done} />}
          </Stack>
        ))
      )}
    </Stack>
  )
}

/** A step's place in the log: two steps of a job may share a name. */
const stepKey = (step: LogStep, i: number) => `${step.jobId ?? step.job}›${i}›${step.step}`

function StepLog({ s, step, at, byJob }: { s: OpenRun; step: LogStep; at: number; byJob: boolean }) {
  const key = stepKey(step, at)
  const open = s.openSteps[key] ?? step.failed
  const title = byJob ? step.step : `${step.job} › ${step.step}`
  return (
    <Collapsible
      title={`${step.failed ? '✕ ' : ''}${title}`}
      description={step.dropped ? `Showing the last ${count(step.lines.length)} of ${count(step.lines.length + step.dropped)} lines` : undefined}
      open={open}
      onChange={(next) => toggleStep(key, next)}
    >
      <CodeView code={step.lines.join('\n') || '(no output)'} label={title} wrap maxHeight="md" />
    </Collapsible>
  )
}

/** The job a job log came from, as the log names it. */
function answerJob(answer: LogView['answer']): string | null {
  return answer?.ok ? (answer.logs.steps[0]?.job ?? null) : null
}

function Logs({ s, run }: { s: OpenRun; run: RunDetail }) {
  const logs = s.logs
  if (!logs) return null
  // A job's log, even when a newer attempt's jobs no longer list it.
  const byJob = logs.job !== null
  const job = byJob ? run.jobs.find((j) => j.id === logs.job) : null
  const title = byJob ? `Log · ${job?.name ?? answerJob(logs.answer) ?? 'job'}` : 'Failed steps'
  const answer = logs.answer
  const body = (l: RunLogs) => (
    <Stack gap="sm">
      {l.steps.length === 0 && (
        <Text size="sm" muted>
          {byJob ? 'This job wrote no log.' : 'No failed step wrote a log line.'}
        </Text>
      )}
      {l.steps.map((step, i) => (
        <StepLog key={stepKey(step, i)} s={s} step={step} at={i} byJob={byJob} />
      ))}
      {l.unread.map((u) => (
        <Text key={u.job} size="xs" muted>{`${u.job}: the log could not be read. ${u.message}`}</Text>
      ))}
      {l.skippedJobs > 0 && (
        <Text size="xs" muted>{`${l.skippedJobs} more failed job${l.skippedJobs === 1 ? '' : 's'}: open them with View log, or on GitHub.`}</Text>
      )}
      <Row gap="xs" wrap>
        <Button size="sm" variant="ghost" icon="open-external" onPress={() => shell.openExternal(l.url)}>
          Full log on GitHub
        </Button>
        {byJob && run.state === 'failure' && (
          <Button size="sm" variant="ghost" onPress={() => loadLogs(null)}>
            Show failed steps only
          </Button>
        )}
      </Row>
    </Stack>
  )
  return (
    <Stack gap="xs">
      <Text size="sm" weight="semibold">
        {title}
      </Text>
      {answer === null ? (
        <Skeleton lines={4} label="Loading the log" />
      ) : answer.ok ? (
        body(answer.logs)
      ) : (
        <Problem error={answer.error} onRetry={() => loadLogs(logs.job)} />
      )}
    </Stack>
  )
}

function Top({ url }: { url: string | null }) {
  return (
    <Row justify="between" align="center">
      <Button size="sm" variant="outline" onPress={backToRuns}>
        ← Back to runs
      </Button>
      {url && <IconButton icon="open-external" label="Open on GitHub" variant="ghost" onPress={() => shell.openExternal(url)} />}
    </Row>
  )
}

export function RunView() {
  const s = read(runView)
  const answer = s.answer
  if (answer === null) {
    return (
      <Stack gap="sm">
        <Top url={null} />
        <Skeleton lines={8} label="Loading the run" />
      </Stack>
    )
  }
  if (!answer.ok) {
    return (
      <Stack gap="sm">
        <Top url={null} />
        <Problem error={answer.error} onRetry={loadRun} />
      </Stack>
    )
  }
  const run = answer.run
  const look = runLook(run)
  return (
    <Box grow minHeight={0} gap="sm">
      <Top url={run.url} />
      <Box grow minHeight={0} scroll="y" gap="md">
        <Text size="md" weight="semibold">
          {run.title}
        </Text>
        <Row gap="xs" align="center" wrap>
          <Glyph look={look} />
          <Text size="sm" tone={look.tone}>
            {look.label}
          </Text>
          <Text size="sm" muted>
            {`${run.workflow} #${run.runNumber}${run.attempt > 1 ? ` · attempt ${run.attempt}` : ''}`}
          </Text>
        </Row>
        <Live s={s} run={run} />
        {run.state === 'waiting' && run.waitingFor.length > 0 && (
          <Callout tone="warning" title={`Waiting for approval to deploy to ${run.waitingFor.join(', ')}`}>
            <Row>
              <Button size="sm" variant="outline" icon="open-external" onPress={() => shell.openExternal(run.url)}>
                Review deployments on GitHub
              </Button>
            </Row>
          </Callout>
        )}
        <KeyValue items={details(run)} />
        <Actions s={s} run={run} />
        {s.error && <Problem error={s.error} onRetry={dismissError} retryLabel="Dismiss" />}
        <Jobs s={s} run={run} />
        <Logs s={s} run={run} />
      </Box>
    </Box>
  )
}

function InputField({ input, value }: { input: DispatchInput; value: string }) {
  const label = `${input.name}${input.required ? ' *' : ''}`
  const hint = input.description ?? undefined
  if (input.type === 'boolean') {
    return (
      <Stack gap="none">
        <Switch label={label} checked={value === 'true'} onChange={(on) => setValue(input.name, String(on))} />
        {hint && (
          <Text size="xs" muted>
            {hint}
          </Text>
        )}
      </Stack>
    )
  }
  const field =
    input.options.length > 0 ? (
      <Select
        label={label}
        value={value}
        placeholder="Choose"
        options={[...(input.required ? [] : [{ value: '', label: 'None' }]), ...input.options.map((o) => ({ value: o, label: o }))]}
        onChange={(next) => setValue(input.name, next)}
      />
    ) : (
      <Input label={label} value={value} placeholder={input.type === 'number' ? '0' : undefined} onChange={(next) => setValue(input.name, next)} />
    )
  return (
    <Stack gap="none">
      {field}
      {hint && (
        <Text size="xs" muted>
          {hint}
        </Text>
      )}
    </Stack>
  )
}

function FormBody({ d }: { d: DispatchState }) {
  if (d.form === null) return <Skeleton lines={3} label="Reading the workflow" />
  if (!d.form.ok) return <Problem error={d.form.error} onRetry={loadForm} />
  const form = d.form.form
  if (!form.dispatch) {
    return (
      <Callout tone="neutral" title="This workflow cannot be run by hand">
        <Text size="sm">{`Its file on ${form.ref} has no workflow_dispatch trigger. Add one to run it from here.`}</Text>
      </Callout>
    )
  }
  if (form.inputs === null) {
    return (
      <Stack gap="sm">
        <Text size="sm" muted>
          The panel could not read this workflow's inputs. Enter them as name and value; empty rows are left out.
        </Text>
        {d.rows.map((row, i) => (
          <Box key={i} columns={2} gap="sm">
            <Input label={`Input ${i + 1} name`} labelHidden placeholder="name" value={row.name} onChange={(name) => setRow(i, { name })} />
            <Input label={`Input ${i + 1} value`} labelHidden placeholder="value" value={row.value} onChange={(value) => setRow(i, { value })} />
          </Box>
        ))}
        <Row>
          <Button size="sm" variant="ghost" icon="add" onPress={addRow}>
            Add input
          </Button>
        </Row>
      </Stack>
    )
  }
  if (form.inputs.length === 0) {
    return (
      <Text size="sm" muted>
        This workflow takes no inputs.
      </Text>
    )
  }
  return (
    <Stack gap="sm">
      {form.inputs.map((input) => (
        <InputField key={input.name} input={input} value={d.values[input.name] ?? ''} />
      ))}
    </Stack>
  )
}

/** After Run workflow, when GitHub had not shown the run yet: it shows on the list in a moment. */
export function Requested() {
  const r = read(requested)
  if (!r) return null
  return (
    <Row gap="xs" align="center" wrap>
      <Text size="xs" muted>{`Run requested on ${r.ref}; it shows in a few seconds. Refresh to look again.`}</Text>
      <IconButton icon="close" label="Dismiss" variant="ghost" size="xs" onPress={forgetRequested} />
    </Row>
  )
}

export function DispatchView() {
  const d = read(dispatch)
  const workflows = read(choices).workflows
  const ready = d.form?.ok && d.form.form.dispatch
  const empty = missing(d)
  const moved = refChanged(d)
  return (
    <Box grow minHeight={0} gap="sm">
      <Row>
        <Button size="sm" variant="outline" onPress={leaveDispatch}>
          ← Back to runs
        </Button>
      </Row>
      <Box grow minHeight={0} scroll="y" gap="md">
        <Text size="md" weight="semibold">
          Run workflow
        </Text>
        <Select
          label="Workflow"
          value={d.workflow === null ? '' : String(d.workflow)}
          placeholder={workflows === null ? 'Loading...' : 'Choose a workflow'}
          options={(workflows ?? []).map((w) => ({ value: String(w.id), label: w.name }))}
          disabled={d.busy}
          onChange={(value) => pickWorkflow(Number(value))}
        />
        {workflows?.length === 0 && (
          <Text size="sm" muted>
            This repository has no workflows.
          </Text>
        )}
        {d.workflow !== null && (
          <>
            <Stack gap="none">
              <Input label="Branch or tag" value={d.ref} placeholder="main" disabled={d.busy} onChange={setRef} onSubmit={() => loadForm()} />
              <Text size="xs" muted>
                The workflow file is read from it. Press Enter after changing it.
              </Text>
            </Stack>
            <FormBody d={d} />
          </>
        )}
        {d.error && <Problem error={d.error} />}
        <Row gap="xs" align="center" wrap>
          <Button size="sm" variant="solid" disabled={!ready || d.busy || empty.length > 0 || moved} onPress={runWorkflow}>
            Run workflow
          </Button>
          <Button size="sm" variant="ghost" onPress={leaveDispatch}>
            Cancel
          </Button>
          {d.busy && <Spinner label="Starting the run" labelHidden />}
          {moved ? (
            <Text size="xs" muted>{`Press Enter in Branch or tag to read the workflow at ${d.ref.trim() || 'the default branch'}.`}</Text>
          ) : (
            ready &&
            empty.length > 0 && <Text size="xs" muted>{`Fill in ${empty.join(', ')}.`}</Text>
          )}
        </Row>
      </Box>
    </Box>
  )
}
