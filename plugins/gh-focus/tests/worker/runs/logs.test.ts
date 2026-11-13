// gh's job logs cut into steps and trimmed to one panel message.
import { assert, test } from 'orca/testing'
import { cleanLine, LINE_CHARS, LOG_BYTES, parseLog, trimSteps } from '../../../src/worker/runs/logs'
import type { LogStep } from '../../../src/shared/protocol'

// As `gh run view --job N --log` prints it: a byte order mark on the first line, a timestamp on each.
const LOG = [
  'test (ubuntu)\tSet up job\t﻿2026-11-13T06:42:17.1Z Current runner version: 2.330.0',
  'test (ubuntu)\tSet up job\t2026-11-13T06:42:17.2Z ##[group]Runner Image',
  'test (ubuntu)\tSet up job\t2026-11-13T06:42:17.3Z   Image: ubuntu-24.04',
  'test (ubuntu)\tSet up job\t2026-11-13T06:42:17.4Z ##[endgroup]',
  'test (ubuntu)\tTest\t2026-11-13T06:42:37.0Z ##[start-action display=Test;id=__self.__run_5]',
  'test (ubuntu)\tTest\t2026-11-13T06:42:37.3360027Z \u001b[31m✕ writes 25k rows\u001b[0m',
  'test (ubuntu)\tTest\t2026-11-13T06:42:53.0Z ##[error]Process completed with exit code 1.',
  'test (ubuntu)\tTest\t2026-11-13T06:42:53.1Z ##[end-action id=__self.__run_5;outcome=failure;conclusion=failure;duration_ms=15]',
  'lint\tTest\t2026-11-13T06:43:00.0Z ok',
  ''
].join('\n')

test('cuts the log into steps in order, without timestamps, colour codes, group or action markers', () => {
  const steps = parseLog(LOG, false)
  assert.deepEqual(
    steps.map((s) => [s.job, s.step, s.lines]),
    [
      ['test (ubuntu)', 'Set up job', ['Current runner version: 2.330.0', 'Runner Image', '  Image: ubuntu-24.04']],
      ['test (ubuntu)', 'Test', ['✕ writes 25k rows', '##[error]Process completed with exit code 1.']],
      ['lint', 'Test', ['ok']]
    ]
  )
  assert.ok(steps.every((s) => s.dropped === 0 && s.failed === false && s.jobId === null))
})

test('a line without the job and step columns stays with the step before it', () => {
  const steps = parseLog('a\tb\t2026-11-13T06:42:17Z one\ncontinued\n', true)
  assert.deepEqual(steps, [{ job: 'a', step: 'b', lines: ['one', 'continued'], dropped: 0, failed: true, jobId: null }])
})

test('a very long line is cut', () => {
  assert.equal(cleanLine('x'.repeat(LINE_CHARS + 50))?.length, LINE_CHARS + 1)
})

function step(name: string, lines: number, width = 99): LogStep {
  return { job: 'j', step: name, lines: Array.from({ length: lines }, (_, i) => `${String(i).padStart(6, '0')} ${'x'.repeat(width - 7)}`), dropped: 0, failed: false, jobId: null }
}

test('small steps stay whole; big ones keep their last lines and count the rest', () => {
  const steps = trimSteps([step('small', 10), step('big', 50_000), step('bigger', 80_000)])
  assert.equal(steps[0].lines.length, 10)
  assert.equal(steps[0].dropped, 0)
  for (const s of steps.slice(1)) {
    assert.ok(s.dropped > 0)
    // The end is kept.
    assert.match(s.lines.at(-1) ?? '', s.step === 'big' ? /^049999 / : /^079999 /)
  }
  assert.equal(steps[1].dropped + steps[1].lines.length, 50_000)
  const used = steps.flatMap((s) => s.lines).reduce((n, l) => n + l.length + 1, 0)
  assert.ok(used <= LOG_BYTES, `${used} bytes`)
  // The two big steps share what the small one left about evenly.
  assert.ok(Math.abs(steps[1].lines.length - steps[2].lines.length) <= 1)
})

test('a 20 MiB log fits one panel message as JSON', () => {
  const big = Array.from({ length: 200_000 }, (_, i) => `job\tTest\t2026-11-13T06:42:17Z ${'ü'.repeat(50)} line ${i}`).join('\n')
  const steps = trimSteps(parseLog(big, true))
  const answer = JSON.stringify({ ok: true, logs: { steps, url: 'https://github.com/o/r/actions/runs/1', skippedJobs: 0 } })
  assert.ok(new TextEncoder().encode(answer).length < 256 * 1024)
  assert.match(steps[0].lines.at(-1) ?? '', /line 199999$/)
})

test('the budget counts lines as JSON: quotes and backslashes take their escapes', () => {
  const heavy = Array.from({ length: 20_000 }, () => `{"path":"C:\\\\work\\\\app","q":"\\"x\\""}`)
  const steps = trimSteps([{ job: 'j', step: 's', lines: heavy, dropped: 0, failed: true, jobId: null }])
  const answer = JSON.stringify({ ok: true, logs: { steps, url: 'u', skippedJobs: 0, unread: [] } })
  assert.ok(new TextEncoder().encode(answer).length <= LOG_BYTES + 1_000)
})

test('a step whose last line is bigger than its share keeps the start of that line', () => {
  const steps = trimSteps([{ job: 'j', step: 's', lines: ['ok', 'Error: ' + 'x'.repeat(1_900)], dropped: 0, failed: true, jobId: null }], 400)
  assert.equal(steps[0].lines.length, 1)
  assert.match(steps[0].lines[0], /^Error: x+…$/)
  assert.equal(steps[0].dropped, 1)
})
