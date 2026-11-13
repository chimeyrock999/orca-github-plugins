// The inputs a workflow takes when run by hand, read from its file's `on:` block. Workflow files are
// YAML; the plugin carries no YAML library, so this reads the small part of YAML that `on:` blocks
// are written in (block mappings and lists, flow lists, quoted and block scalars) and gives up on
// anything else, so the panel can fall back to name and value fields.
import type { DispatchInput } from '../../shared/protocol'

/** A YAML value as far as this reader goes. */
type Value = string | null | Value[] | { [key: string]: Value }

class Unsupported extends Error {}

type Line = { indent: number; text: string; no: number }

/** The text before a comment: `#` at the start or after a space, outside quotes. */
function stripComment(text: string): string {
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = text[i + 1] === quote && quote === "'" ? (i++, quote) : null
      else if (c === '\\' && quote === '"') i++
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s:[{,-]/.test(text[i - 1])) quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd()
    }
  }
  return text.trimEnd()
}

function scalar(raw: string): string | null {
  const text = raw.trim()
  if (text === '' || text === '~' || text === 'null') return null
  if (/^[&*!]/.test(text)) throw new Unsupported('anchors, aliases and tags')
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new Unsupported('an open double quote')
    try {
      return JSON.parse(text) as string
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new Unsupported('an open single quote')
    return text.slice(1, -1).replace(/''/g, "'")
  }
  return text
}

/** `[a, "b", c]`, one level deep. */
function flowList(text: string): Value[] {
  const inner = text.trim().slice(1, -1)
  if (/[[\]{}]/.test(inner)) throw new Unsupported('nested flow collections')
  if (!inner.trim()) return []
  const items: string[] = []
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === ',') {
      items.push(inner.slice(start, i))
      start = i + 1
    }
  }
  items.push(inner.slice(start))
  return items.map(scalar).filter((v) => v !== null)
}

/** The value after `key:` or `- ` on one line. */
function inline(text: string): Value {
  const t = text.trim()
  if (t.startsWith('[')) {
    if (!t.endsWith(']')) throw new Unsupported('a flow list over several lines')
    return flowList(t)
  }
  if (t.startsWith('{')) {
    if (t === '{}') return {}
    throw new Unsupported('flow mappings')
  }
  return scalar(t)
}

// `key:` at the start of a line, the key bare or quoted.
const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#][^:]*?)\s*:(?:\s+(.*))?$/

class Reader {
  private i = 0
  constructor(
    private readonly lines: Line[],
    private readonly raw: string[],
    /** Index of the first raw line past the block. */
    private readonly stop: number
  ) {}

  /** The block at `indent`: a mapping or a list, by its first line. */
  block(indent: number): Value {
    const line = this.lines[this.i]
    if (!line || line.indent < indent) return null
    return line.text.startsWith('- ') || line.text === '-' ? this.list(line.indent) : this.mapping(line.indent)
  }

  private value(rest: string | undefined, parent: number): Value {
    if (rest === undefined || rest === '') {
      const next = this.lines[this.i]
      return next && next.indent > parent ? this.block(next.indent) : null
    }
    if (/^[|>][+-]?\d*$/.test(rest)) return this.blockScalar(rest, parent)
    const next = this.lines[this.i]
    if (next && next.indent > parent && !/^[[{"']/.test(rest)) throw new Unsupported('a plain value over several lines')
    return inline(rest)
  }

  private mapping(indent: number): Value {
    const out: Record<string, Value> = {}
    while (this.i < this.lines.length && this.lines[this.i].indent === indent) {
      const match = KEY.exec(this.lines[this.i].text)
      if (!match) throw new Unsupported(`line ${this.lines[this.i].no}`)
      this.i++
      const key = scalar(match[1]) ?? ''
      out[key] = this.value(match[2], indent)
    }
    this.end(indent)
    return out
  }

  private list(indent: number): Value {
    const out: Value[] = []
    while (this.i < this.lines.length && this.lines[this.i].indent === indent && /^-(\s|$)/.test(this.lines[this.i].text)) {
      const line = this.lines[this.i]
      const rest = line.text.slice(1).trim()
      if (KEY.test(rest) && !/^["']/.test(rest)) {
        // `- cron: ...`: a mapping whose first key sits on the dash's line, at the key's column.
        const at = line.indent + line.text.length - rest.length
        this.lines[this.i] = { ...line, indent: at, text: rest }
        out.push(this.mapping(at))
        continue
      }
      this.i++
      out.push(this.value(rest, indent))
    }
    this.end(indent)
    return out
  }

  /** A deeper line left over means the indentation does not fit any reading. */
  private end(indent: number): void {
    const next = this.lines[this.i]
    if (next && next.indent > indent) throw new Unsupported(`line ${next.no}`)
  }

  /** `|` keeps the line breaks, `>` folds them into spaces; the lines are those deeper than `parent`. */
  private blockScalar(header: string, parent: number): string {
    const first = this.lines[this.i]
    if (!first || first.indent <= parent) return ''
    const kept: string[] = []
    while (this.i < this.lines.length && this.lines[this.i].indent > parent) this.i++
    const to = this.i < this.lines.length ? this.lines[this.i].no - 1 : this.stop
    const body = this.raw.slice(first.no - 1, to)
    const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length))
    for (const l of body) kept.push(l.slice(indent).trimEnd())
    while (kept.length && kept.at(-1) === '') kept.pop()
    return header.startsWith('>') ? kept.join(' ').replace(/\s+/g, ' ').trim() : kept.join('\n')
  }
}

/** The lines of the top-level `on:` key: the key's own line, then every deeper or blank line. */
function onBlock(raw: string[]): { lines: Line[]; stop: number } | null {
  const at = raw.findIndex((l) => /^(on|"on"|'on')\s*:/.test(l))
  if (at < 0) return null
  const lines: Line[] = []
  let n = at
  for (; n < raw.length; n++) {
    const text = raw[n]
    if (n > at && text.trim() && !/^\s/.test(text) && !text.startsWith('#')) break
    if (/\t/.test(text.slice(0, text.length - text.trimStart().length))) throw new Unsupported('tabs')
    const cut = stripComment(text)
    if (!cut.trim()) continue
    lines.push({ indent: cut.length - cut.trimStart().length, text: cut.trim(), no: n + 1 })
  }
  return { lines, stop: n }
}

const TYPES = ['string', 'boolean', 'choice', 'number', 'environment'] as const

function toInput(name: string, spec: Value): DispatchInput {
  const s = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {}
  const text = (v: Value | undefined) => (typeof v === 'string' ? v : null)
  const declared = text(s.type) ?? 'string'
  const type = (TYPES as readonly string[]).includes(declared) ? (declared as DispatchInput['type']) : 'string'
  const fallback = text(s.default)
  const options = Array.isArray(s.options) ? s.options.filter((o): o is string => typeof o === 'string') : []
  return {
    name,
    type,
    description: text(s.description),
    required: text(s.required) === 'true',
    default: type === 'boolean' ? fallback === 'true' : fallback,
    options
  }
}

/**
 * The inputs of `on: workflow_dispatch` in a workflow file: `dispatch` false when the workflow cannot
 * be run by hand, `inputs` null when the file is written in YAML this reader does not follow.
 */
export function dispatchInputs(yaml: string): { dispatch: boolean; inputs: DispatchInput[] | null } {
  const raw = yaml.replace(/\r\n?/g, '\n').split('\n')
  try {
    const block = onBlock(raw)
    if (!block) return { dispatch: false, inputs: [] }
    const top = new Reader(block.lines, raw, block.stop).block(0) as Record<string, Value> | null
    const on = top && !Array.isArray(top) && typeof top === 'object' ? (top.on ?? top['"on"'] ?? null) : null
    if (typeof on === 'string') return { dispatch: on === 'workflow_dispatch', inputs: [] }
    if (Array.isArray(on)) return { dispatch: on.includes('workflow_dispatch'), inputs: [] }
    if (!on || !('workflow_dispatch' in on)) return { dispatch: false, inputs: [] }
    const dispatch = on.workflow_dispatch
    const inputs = dispatch && typeof dispatch === 'object' && !Array.isArray(dispatch) ? dispatch.inputs : null
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return { dispatch: true, inputs: [] }
    return { dispatch: true, inputs: Object.entries(inputs).map(([name, spec]) => toInput(name, spec)) }
  } catch (error) {
    if (error instanceof Unsupported) return { dispatch: /^\s*-?\s*workflow_dispatch\b|\bworkflow_dispatch\s*[:\],]/m.test(yaml), inputs: null }
    throw error
  }
}
