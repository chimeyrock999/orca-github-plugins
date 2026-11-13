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

/** `maxBuffer`: bytes of output read before gh is stopped (default 4 MiB). */
export type GhOptions = { cwd?: string; signal?: AbortSignal; timeoutMs?: number; json?: boolean; maxBuffer?: number }
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

/** Runs `gh <args>`: its stdout, parsed when `json` is set. Throws a GhError on any failure. */
export async function runGh(args: string[], options: GhOptions = {}, runner: Run = run): Promise<unknown> {
  let result: RunResult
  try {
    result = await runner('gh', args, { cwd: options.cwd, signal: options.signal, timeoutMs: options.timeoutMs, maxBuffer: options.maxBuffer })
  } catch (error) {
    throw spawnFailure(error)
  }
  if (result.code !== 0) {
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
