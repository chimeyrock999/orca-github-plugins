// Child processes: the host API cannot run one, but a trusted-worker is plain Node.
import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'
import type { RepoError } from './protocol'

export type RunResult = { code: number; stdout: string; stderr: string }
/** Resolves with the exit code; rejects only when the command did not run (ENOENT, timeout). */
export type Run = (cmd: string, args: string[], options: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>

// Orca 1.4.256 hands workers the login shell's PATH. Homebrew's folders go after it, for a launch
// from the Dock that leaves only launchd's, so a gh the user's PATH picks first still wins.
export function fallbackPath(path: string | undefined): string {
  return [path ?? '/usr/bin:/bin:/usr/sbin:/sbin', '/opt/homebrew/bin', '/usr/local/bin'].join(delimiter)
}

const ENV = { ...process.env, PATH: fallbackPath(process.env.PATH) }

export const run: Run = (cmd, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd: options.cwd, env: ENV, timeout: options.timeoutMs ?? 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code
        if (error && typeof code !== 'number') return reject(error)
        resolve({ code: typeof code === 'number' ? code : 0, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })

export type GhRepoAnswer = { ok: true; nameWithOwner: string } | { ok: false; error: RepoError }

function ghError(stderr: string, exitCode: number): RepoError {
  const message = stderr.trim() || `gh exited with ${exitCode}`
  // First: gh's "no GitHub remote" message also says `gh auth login`.
  if (/not a git repository|known GitHub host|no git remotes/i.test(stderr)) return { code: 'not_a_repo', message }
  if (exitCode === 4 || /gh auth login/.test(stderr)) return { code: 'gh_logged_out', message }
  return { code: 'gh_failed', message }
}

/** `owner/name` of the repo gh picks for the folder, by gh's own remote rules. */
export async function ghRepo(path: string, runner: Run = run): Promise<GhRepoAnswer> {
  let result: RunResult
  try {
    result = await runner('gh', ['repo', 'view', '--json', 'nameWithOwner'], { cwd: path })
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return { ok: false, error: { code: 'gh_missing', message: 'The GitHub CLI (gh) is not installed or not on PATH.' } }
    }
    return { ok: false, error: { code: 'gh_failed', message: String((error as Error).message ?? error) } }
  }
  if (result.code !== 0) return { ok: false, error: ghError(result.stderr, result.code) }
  try {
    const nameWithOwner = JSON.parse(result.stdout).nameWithOwner
    if (typeof nameWithOwner === 'string' && nameWithOwner.includes('/')) return { ok: true, nameWithOwner }
  } catch {}
  return { ok: false, error: { code: 'gh_failed', message: `Unexpected gh output: ${result.stdout.slice(0, 200)}` } }
}

// The app's own CLI first: a bare `orca` on PATH can be an unrelated program.
const ORCA_CLIS = ['/Applications/Orca.app/Contents/Resources/bin/orca', 'orca']
const TERMINAL_HANDLE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/

/** `worktreePath` from `orca terminal show --json`; null for a stale handle or any other shape. */
export function parseTerminalShow(stdout: string): string | null {
  try {
    const path = JSON.parse(stdout)?.result?.terminal?.worktreePath
    return typeof path === 'string' && path.length > 0 ? path : null
  } catch {
    return null
  }
}

/** The folder a terminal runs in. The Orca CLI's JSON is not part of the plugin contract, so any
 *  failure is null and the caller falls back. */
export async function terminalPath(terminalId: string, runner: Run = run): Promise<string | null> {
  if (!TERMINAL_HANDLE.test(terminalId)) return null
  for (const cli of ORCA_CLIS) {
    try {
      const result = await runner(cli, ['terminal', 'show', `--terminal=${terminalId}`, '--json'], { timeoutMs: 5_000 })
      return parseTerminalShow(result.stdout)
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') continue
      return null
    }
  }
  return null
}
