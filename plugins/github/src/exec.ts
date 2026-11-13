// Child processes: the host API cannot run one, but a trusted-worker is plain Node.
import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'

export type RunResult = { code: number; stdout: string; stderr: string }
/** Resolves with the exit code; rejects only when the command did not run (ENOENT, timeout, abort). */
export type Run = (
  cmd: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }
) => Promise<RunResult>

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
      { cwd: options.cwd, env: ENV, signal: options.signal, timeout: options.timeoutMs ?? 15_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code
        if (error && typeof code !== 'number') return reject(error)
        resolve({ code: typeof code === 'number' ? code : 0, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })

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

/** What the Orca CLI printed for `args`, from the first CLI found; null when none ran. */
async function orcaCli(args: string[], runner: Run): Promise<string | null> {
  for (const cli of ORCA_CLIS) {
    try {
      return (await runner(cli, args, { timeoutMs: 5_000 })).stdout
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') continue
      return null
    }
  }
  return null
}

/** The folder a terminal runs in. The Orca CLI's JSON is not part of the plugin contract, so any
 *  failure is null and the caller falls back. */
export async function terminalPath(terminalId: string, runner: Run = run): Promise<string | null> {
  if (!TERMINAL_HANDLE.test(terminalId)) return null
  const stdout = await orcaCli(['terminal', 'show', `--terminal=${terminalId}`, '--json'], runner)
  return stdout === null ? null : parseTerminalShow(stdout)
}

/** The GitHub issue and pull request Orca links to a workspace, and its project (`github:o/r`). */
export type WorkspaceLinks = { project: string | null; issue: number | null; pull: number | null }

/** The links in `orca worktree show --json`; null for any other shape. */
export function parseWorktreeShow(stdout: string): WorkspaceLinks | null {
  try {
    const w = JSON.parse(stdout)?.result?.worktree
    if (!w || typeof w !== 'object') return null
    const number = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)
    return { project: typeof w.projectId === 'string' ? w.projectId : null, issue: number(w.linkedIssue), pull: number(w.linkedPR) }
  } catch {
    return null
  }
}

/** What Orca links to the workspace in `path` (a workspace made from an issue or pull request).
 *  Like terminalPath, any failure is null: the panel then just shows the list. */
export async function workspaceLinks(path: string, runner: Run = run): Promise<WorkspaceLinks | null> {
  const stdout = await orcaCli(['worktree', 'show', `--worktree=path:${path}`, '--json'], runner)
  return stdout === null ? null : parseWorktreeShow(stdout)
}
