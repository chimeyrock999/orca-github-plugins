// Every GitHub call goes through the gh CLI the user is logged in to; this file runs it and turns
// its failures into codes the panel can explain.
import { run, type Run, type RunResult } from './exec'
import type { ErrorCode, PanelError } from '../shared/protocol'

export class GhError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'GhError'
  }
}

/** `maxBuffer`: bytes of output read before gh is stopped (default 4 MiB). `partial`: a GraphQL
 *  answer whose only errors say something was not found or not allowed (another org's SAML, say) is
 *  returned with the data it has (gh exits 1 on any error). `etag`: a conditional REST read (`gh api
 *  -i`, with `If-None-Match` when it is a string); the answer is then a Conditional. */
export type GhOptions = { cwd?: string; signal?: AbortSignal; timeoutMs?: number; json?: boolean; maxBuffer?: number; partial?: boolean; etag?: string | null }

/** What GitHub says of the rate limit an answer counted against (`X-RateLimit-*`). */
export type RateLimit = { resource: string; limit: number; remaining: number; resetAt: number }

/** A conditional REST read: 304 means the body behind `etag` is still current (GitHub does not count
 *  it against the rate limit), and `body` is then null. */
export class Conditional {
  constructor(
    readonly status: 200 | 304,
    readonly etag: string | null,
    readonly body: unknown,
    readonly rate: RateLimit | null
  ) {}
}
/** runGh with the runner bound: what handlers take, so tests hand them a fake. */
export type Gh = (args: string[], options?: GhOptions) => Promise<unknown>

/** The code for a gh run that exited non-zero, from its exit code and stderr. */
export function failureCode(stderr: string, exitCode: number): ErrorCode {
  // First: gh's "no GitHub remote" message also says `gh auth login`.
  if (/not a git repository|known GitHub host|no git remotes/i.test(stderr)) return 'not_a_repo'
  if (/rate limit/i.test(stderr)) return 'rate_limited'
  if (exitCode === 4 || /gh auth login|HTTP 401/.test(stderr)) return 'gh_logged_out'
  if (/HTTP 404|Could not resolve to/i.test(stderr)) return 'not_found'
  return 'gh_failed'
}

function spawnFailure(error: unknown): GhError {
  const e = error as { code?: unknown; name?: unknown; killed?: unknown; message?: unknown }
  if (e.code === 'ENOENT') return new GhError('gh_missing', 'The GitHub CLI (gh) is not installed or not on PATH.')
  if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return new GhError('cancelled', 'The request was cancelled.')
  // Node also kills a child whose output outgrows maxBuffer; that is no timeout, and no retry helps.
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new GhError('gh_failed', 'gh answered with more output than the panel reads.')
  if (e.killed === true) return new GhError('timeout', 'gh did not answer in time.')
  return new GhError('gh_failed', String(e.message ?? error))
}

/** A GraphQL answer with data whose errors all say something was not found or not allowed; null
 *  otherwise. */
function partialAnswer(stdout: string): unknown {
  try {
    const out = JSON.parse(stdout) as { data?: unknown; errors?: { type?: unknown }[] }
    const notFound = Array.isArray(out?.errors) && out.errors.every((e) => e?.type === 'NOT_FOUND' || e?.type === 'FORBIDDEN')
    return out?.data && typeof out.data === 'object' && notFound ? out : null
  } catch {
    return null
  }
}

/** `gh api -i` output split into its status, headers (lower-cased names) and body; null when it
 *  does not start with a status line. */
function withHeaders(stdout: string): { status: number; headers: Map<string, string>; body: string } | null {
  const lines = stdout.split('\n')
  const status = /^HTTP\/\S+ (\d{3})/.exec(lines[0] ?? '')
  if (!status) return null
  const headers = new Map<string, string>()
  let i = 1
  for (; i < lines.length && lines[i].trim() !== ''; i++) {
    const colon = lines[i].indexOf(':')
    if (colon > 0) headers.set(lines[i].slice(0, colon).trim().toLowerCase(), lines[i].slice(colon + 1).trim())
  }
  return { status: Number(status[1]), headers, body: lines.slice(i + 1).join('\n') }
}

function rateOf(headers: Map<string, string>): RateLimit | null {
  const limit = Number(headers.get('x-ratelimit-limit'))
  const remaining = Number(headers.get('x-ratelimit-remaining'))
  const reset = Number(headers.get('x-ratelimit-reset'))
  if (!headers.has('x-ratelimit-remaining') || ![limit, remaining, reset].every(Number.isFinite)) return null
  return { resource: headers.get('x-ratelimit-resource') ?? 'core', limit, remaining, resetAt: reset * 1000 }
}

/** A conditional read's output as a Conditional; null when it is no 200 or 304 (a failure, which
 *  then goes the usual way). */
function conditional(stdout: string): Conditional | null {
  const answer = withHeaders(stdout)
  if (!answer || (answer.status !== 200 && answer.status !== 304)) return null
  const rate = rateOf(answer.headers)
  const etag = answer.headers.get('etag') ?? null
  if (answer.status === 304) return new Conditional(304, etag, null, rate)
  try {
    return new Conditional(200, etag, JSON.parse(answer.body), rate)
  } catch {
    throw new GhError('gh_failed', `Unexpected gh output: ${answer.body.slice(0, 200)}`)
  }
}

/** Runs `gh <args>`: its stdout, parsed when `json` is set. Throws a GhError on any failure. */
export async function runGh(args: string[], options: GhOptions = {}, runner: Run = run): Promise<unknown> {
  const asked = options.etag !== undefined
  const full = asked ? [...args, '-i', ...(options.etag ? ['-H', `If-None-Match: ${options.etag}`] : [])] : args
  let result: RunResult
  try {
    result = await runner('gh', full, { cwd: options.cwd, signal: options.signal, timeoutMs: options.timeoutMs, maxBuffer: options.maxBuffer })
  } catch (error) {
    throw spawnFailure(error)
  }
  // gh exits 1 on a 304 and prints its headers; anything else it failed with fails as usual.
  if (asked) {
    const answer = conditional(result.stdout)
    if (answer) return answer
  }
  if (result.code !== 0) {
    const partial = options.json && options.partial ? partialAnswer(result.stdout) : null
    if (partial) return partial
    const message = result.stderr.trim() || `gh exited with ${result.code}`
    throw new GhError(failureCode(result.stderr, result.code), message)
  }
  if (!options.json) return result.stdout
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new GhError('gh_failed', `Unexpected gh output: ${result.stdout.slice(0, 200)}`)
  }
}

/** A GhError as a failed answer; any other error is a bug and is thrown again. */
export function toFailure(error: unknown): { ok: false; error: PanelError } {
  if (error instanceof GhError) return { ok: false, error: { code: error.code, message: error.message } }
  throw error
}
