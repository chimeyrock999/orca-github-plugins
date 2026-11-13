// Job logs as gh prints them (`job⇥step⇥timestamp text`, one line each), cut into steps and trimmed
// so a whole answer stays under the 256 KiB panel message limit. Pure, so tests pin it.
import type { LogStep } from '../../shared/protocol'

/** Bytes of log text one answer may carry, all steps together; the rest of the answer is small. */
export const LOG_BYTES = 180_000
/** A longer line is cut: one minified bundle must not take a step's whole share. */
export const LINE_CHARS = 2_000

// GitHub's timestamp on each line, after an optional byte order mark.
const STAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/
// Colour and cursor codes some tools print even without a terminal.
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

/** One log line as the panel shows it: no timestamp, no colour codes, no group markers. Null for a
 *  line that only closes a group or marks where an action starts or ends. */
export function cleanLine(text: string): string | null {
  const line = text.replace(STAMP, '').replace(/^\uFEFF/, '').replace(ANSI, '').replace(/\r$/, '')
  if (/^##\[(endgroup|start-action|end-action)\b/.test(line)) return null
  const shown = line.startsWith('##[group]') ? line.slice('##[group]'.length) : line
  return shown.length > LINE_CHARS ? `${shown.slice(0, LINE_CHARS)}…` : shown
}

/** gh's log output cut into steps, in the order they ran. A line without the two tabs belongs to the
 *  step before it. */
export function parseLog(text: string, failed: boolean): LogStep[] {
  const steps: LogStep[] = []
  for (const raw of text.split('\n')) {
    if (raw === '') continue
    const first = raw.indexOf('\t')
    const second = first < 0 ? -1 : raw.indexOf('\t', first + 1)
    const job = second < 0 ? null : raw.slice(0, first)
    const step = second < 0 ? null : raw.slice(first + 1, second)
    const line = cleanLine(second < 0 ? raw : raw.slice(second + 1))
    let last = steps.at(-1)
    if (job !== null && step !== null && (!last || last.job !== job || last.step !== step)) {
      last = { job, step, lines: [], dropped: 0, failed, jobId: null }
      steps.push(last)
    }
    if (last && line !== null) last.lines.push(line)
  }
  return steps
}

// As the line takes in the JSON answer: quoted, escaped, and a comma after it.
const bytes = (line: string) => Buffer.byteLength(JSON.stringify(line), 'utf8') + 1

/** Keeps the end of each step, where the error usually is, so all of them fit in `budget` bytes. A
 *  small step keeps all its lines and leaves its unused share to the bigger ones. */
export function trimSteps(steps: LogStep[], budget = LOG_BYTES): LogStep[] {
  const sizes = steps.map((s) => s.lines.reduce((n, l) => n + bytes(l), 0))
  const share = new Array<number>(steps.length).fill(0)
  let left = budget
  // Smallest first: each takes what it needs, up to an equal share of what is left.
  const order = steps.map((_, i) => i).sort((a, b) => sizes[a] - sizes[b])
  order.forEach((i, k) => {
    share[i] = Math.min(sizes[i], Math.floor(left / (order.length - k)))
    left -= share[i]
  })
  return steps.map((step, i) => {
    if (sizes[i] <= share[i]) return step
    let used = 0
    let from = step.lines.length
    while (from > 0 && used + bytes(step.lines[from - 1]) <= share[i]) used += bytes(step.lines[--from])
    // A last line bigger than the whole share keeps its start: the error is often there.
    if (from === step.lines.length && step.lines.length > 0) {
      const last = step.lines[from - 1]
      return { ...step, lines: [`${last.slice(0, Math.max(0, Math.floor(share[i] / 8)))}…`], dropped: step.dropped + from - 1 }
    }
    return { ...step, lines: step.lines.slice(from), dropped: step.dropped + from }
  })
}
