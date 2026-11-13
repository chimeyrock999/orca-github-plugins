// Child processes: the host API cannot run one, but a trusted-worker is plain Node.
import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'
import { isRepoName } from '../shared/protocol'

export type RunResult = { code: number; stdout: string; stderr: string }
/** Resolves with the exit code; rejects only when the command did not run (ENOENT, timeout, abort). */
export type Run = (
  cmd: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; maxBuffer?: number }
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
      { cwd: options.cwd, env: ENV, signal: options.signal, timeout: options.timeoutMs ?? 15_000, maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024 },
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

/** A GitHub issue or pull request Orca links to a workspace. `repo` is the `owner/name` its URL (or
 *  task source) names; null when Orca says neither, which means the workspace's own repo. `host` is
 *  its URL's host (GitHub Enterprise has its own), null without a URL. */
export type LinkedItem = { type: 'issue' | 'pull'; number: number; repo: string | null; title: string | null; url: string | null; host: string | null }
/** What Orca links to a workspace, and its project (`github:o/r`). */
export type WorkspaceLinks = { project: string | null; items: LinkedItem[] }

const ITEM_URL = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/(?:issues|pull)\/\d+(?:[/?#]|$)/

const positive = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)
const text = (v: unknown) => (typeof v === 'string' && v ? v : null)

/** One of Orca's `linkedItems` (a workspace attachment), when it is a GitHub issue or pull request. */
function linkedItem(item: unknown): LinkedItem | null {
  const i = item as { provider?: unknown; type?: unknown; number?: unknown; title?: unknown; url?: unknown; taskSourceContext?: { projectId?: unknown } } | null
  const number = positive(i?.number)
  if (!i || i.provider !== 'github' || (i.type !== 'issue' && i.type !== 'pr') || !number) return null
  const url = text(i.url)
  const source = text(i.taskSourceContext?.projectId)
  const parts = url?.match(ITEM_URL)
  const repo = parts?.[2] ?? (source?.startsWith('github:') ? source.slice('github:'.length) : null)
  // A name that is not owner/name (`..`, say) never becomes a repo the worker reads or writes.
  if (repo !== null && !isRepoName(repo)) return null
  return { type: i.type === 'pr' ? 'pull' : 'issue', number, repo, title: text(i.title), url, host: parts?.[1].toLowerCase() ?? null }
}

/** The links in `orca worktree show --json`: every linked item, then, as Orca's own
 *  getWorkspaceAttachments does, the one `linkedIssue` and `linkedPR` it kept before when the list
 *  does not have them (an older Orca has no list at all); null for any other shape. */
export function parseWorktreeShow(stdout: string): WorkspaceLinks | null {
  try {
    const w = JSON.parse(stdout)?.result?.worktree
    if (!w || typeof w !== 'object') return null
    const project = typeof w.projectId === 'string' ? w.projectId : null
    const items: LinkedItem[] = Array.isArray(w.linkedItems) ? w.linkedItems.flatMap((i: unknown) => linkedItem(i) ?? []) : []
    // The legacy fields name the workspace's own repo.
    const own = project?.startsWith('github:') ? project.slice('github:'.length).toLowerCase() : null
    for (const [type, v] of [['issue', w.linkedIssue], ['pull', w.linkedPR]] as const) {
      const number = positive(v)
      const listed = items.some((i) => i.type === type && i.number === number && (!i.repo || i.repo.toLowerCase() === own))
      if (number && !listed) items.push({ type, number, repo: null, title: null, url: null, host: null })
    }
    return { project, items }
  } catch {
    return null
  }
}

/** What Orca links to the workspace in `path` (made from an issue or pull request, or linked to one).
 *  Like terminalPath, any failure is null: the panel then shows none. */
export async function workspaceLinks(path: string, runner: Run = run): Promise<WorkspaceLinks | null> {
  const stdout = await orcaCli(['worktree', 'show', `--worktree=path:${path}`, '--json'], runner)
  return stdout === null ? null : parseWorktreeShow(stdout)
}

/** The branch checked out in `path` as GitHub names it: the branch it pushes to when it tracks one
 *  (local `fix` tracking `origin/user/fix` is `user/fix`), else its own name. Null when detached or
 *  git fails. */
export async function currentBranch(path: string, runner: Run = run): Promise<string | null> {
  try {
    const head = await runner('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: path, timeoutMs: 5_000 })
    const branch = head.code === 0 ? head.stdout.trim() : ''
    if (!branch || branch === 'HEAD') return null
    const merge = await runner('git', ['config', '--get', `branch.${branch}.merge`], { cwd: path, timeoutMs: 5_000 })
    const upstream = merge.code === 0 ? merge.stdout.trim().replace(/^refs\/heads\//, '') : ''
    return upstream || branch
  } catch {
    return null
  }
}
