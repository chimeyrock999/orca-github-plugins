// ghRepo and terminalPath over a fake runner, plus one run against the real gh and orca.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { assert, test } from 'orca/testing'
import { delimiter } from 'node:path'
import { fallbackPath, ghRepo, parseTerminalShow, run, terminalPath, type Run } from './exec'

function fake(answer: { code: number; stdout?: string; stderr?: string } | NodeJS.ErrnoException): Run & { calls: unknown[][] } {
  const calls: unknown[][] = []
  const runner = async (cmd: string, args: string[], options: { cwd?: string }) => {
    calls.push([cmd, args, options.cwd])
    if (answer instanceof Error) throw answer
    return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }
  return Object.assign(runner, { calls })
}

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
}

test('ghRepo answers nameWithOwner from gh repo view in the folder', async () => {
  const runner = fake({ code: 0, stdout: '{"nameWithOwner":"octo/app"}\n' })
  assert.deepEqual(await ghRepo('/code/app', runner), { ok: true, nameWithOwner: 'octo/app' })
  assert.deepEqual(runner.calls, [['gh', ['repo', 'view', '--json', 'nameWithOwner'], '/code/app']])
})

test('ghRepo: gh not installed', async () => {
  const result = await ghRepo('/code/app', fake(enoent()))
  assert.equal(!result.ok && result.error.code, 'gh_missing')
})

test('ghRepo: logged out (exit 4)', async () => {
  const result = await ghRepo('/code/app', fake({ code: 4, stderr: 'To get started with GitHub CLI, please run:  gh auth login\n' }))
  assert.equal(!result.ok && result.error.code, 'gh_logged_out')
})

test('ghRepo: not a git repository', async () => {
  const result = await ghRepo('/tmp', fake({ code: 1, stderr: 'failed to run git: fatal: not a git repository (or any of the parent directories): .git\n' }))
  assert.equal(!result.ok && result.error.code, 'not_a_repo')
})

test('ghRepo: remotes that are not GitHub', async () => {
  const stderr = 'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`\n'
  const result = await ghRepo('/code/gl', fake({ code: 1, stderr }))
  assert.equal(!result.ok && result.error.code, 'not_a_repo')
})

test('ghRepo: no remotes at all', async () => {
  const result = await ghRepo('/code/new', fake({ code: 1, stderr: 'no git remotes found\n' }))
  assert.equal(!result.ok && result.error.code, 'not_a_repo')
})

test('ghRepo: any other failure keeps gh stderr', async () => {
  const result = await ghRepo('/code/app', fake({ code: 1, stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)\n' }))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'gh_failed')
  assert.match(result.error.message, /HTTP 401/)
})

test('ghRepo: output without nameWithOwner', async () => {
  const result = await ghRepo('/code/app', fake({ code: 0, stdout: 'not json' }))
  assert.equal(!result.ok && result.error.code, 'gh_failed')
})

test('parseTerminalShow reads worktreePath, and null for anything else', () => {
  assert.equal(parseTerminalShow('{"ok":true,"result":{"terminal":{"worktreePath":"/code/app"}}}'), '/code/app')
  assert.equal(parseTerminalShow('{"ok":false,"error":{"code":"terminal_handle_stale"}}'), null)
  assert.equal(parseTerminalShow('{"ok":true,"result":{"terminal":{}}}'), null)
  assert.equal(parseTerminalShow('garbage'), null)
})

test('terminalPath tries the app CLI, then orca on PATH when the app has none', async () => {
  const calls: string[] = []
  const runner: Run = async (cmd) => {
    calls.push(cmd)
    if (cmd !== 'orca') throw enoent()
    return { code: 0, stdout: '{"ok":true,"result":{"terminal":{"worktreePath":"/code/app"}}}', stderr: '' }
  }
  assert.equal(await terminalPath('term_1', runner), '/code/app')
  assert.equal(calls.length, 2)
  assert.equal(calls[1], 'orca')
})

test('terminalPath refuses an id that is not a handle', async () => {
  const runner = fake({ code: 0, stdout: '{}' })
  assert.equal(await terminalPath('--json; rm', runner), null)
  assert.deepEqual(runner.calls, [])
})

test('terminalPath: a failed CLI gives null', async () => {
  assert.equal(await terminalPath('term_1', fake({ code: 1, stdout: '', stderr: 'boom' })), null)
})

function has(cmd: string): boolean {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Real gh, real git: GH_LIVE=1 orca plugin test . (needs gh logged in and network).
test('live: gh resolves this repo, and a folder with no remote is not a repo', async () => {
  if (process.env.GH_LIVE !== '1' || !has('gh') || !has('git')) return
  const here = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const result = await ghRepo(here, run)
  assert.equal(result.ok && result.nameWithOwner, 'chimeyrock999/orca-github-plugins')

  const bare = mkdtempSync(join(tmpdir(), 'github-review-'))
  execFileSync('git', ['init', '-q', bare])
  const empty = await ghRepo(bare, run)
  assert.equal(!empty.ok && empty.error.code, 'not_a_repo')
})

test("the fallback folders come after the user's PATH, so its gh wins", () => {
  assert.equal(fallbackPath('/home/me/.local/bin:/usr/bin'), ['/home/me/.local/bin:/usr/bin', '/opt/homebrew/bin', '/usr/local/bin'].join(delimiter))
  assert.equal(fallbackPath(undefined).split(delimiter)[0], '/usr/bin')
})
