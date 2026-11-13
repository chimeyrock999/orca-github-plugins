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
