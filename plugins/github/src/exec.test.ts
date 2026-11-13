// terminalPath over a fake runner, and the PATH the worker runs commands with.
import { assert, test } from 'orca/testing'
import { delimiter } from 'node:path'
import { fallbackPath, parseTerminalShow, parseWorktreeShow, terminalPath, workspaceLinks, type Run } from './exec'

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

test("the fallback folders come after the user's PATH, so its gh wins", () => {
  assert.equal(fallbackPath('/home/me/.local/bin:/usr/bin'), ['/home/me/.local/bin:/usr/bin', '/opt/homebrew/bin', '/usr/local/bin'].join(delimiter))
  assert.equal(fallbackPath(undefined).split(delimiter)[0], '/usr/bin')
})

test('parseWorktreeShow reads the linked issue, pull request and project', () => {
  const show = (worktree: unknown) => JSON.stringify({ ok: true, result: { worktree } })
  assert.deepEqual(parseWorktreeShow(show({ projectId: 'github:octo/app', linkedIssue: 4, linkedPR: null })), { project: 'github:octo/app', issue: 4, pull: null })
  assert.deepEqual(parseWorktreeShow(show({ linkedIssue: '4', linkedPR: 131 })), { project: null, issue: null, pull: 131 })
  assert.equal(parseWorktreeShow('{"ok":false,"error":{"code":"selector_not_found"}}'), null)
  assert.equal(parseWorktreeShow('garbage'), null)
})

test('workspaceLinks asks the CLI by path, and a CLI that will not run is null', async () => {
  const runner = fake({ code: 0, stdout: JSON.stringify({ ok: true, result: { worktree: { projectId: 'github:octo/app', linkedIssue: 4 } } }) })
  assert.deepEqual(await workspaceLinks('/code/app wt', runner), { project: 'github:octo/app', issue: 4, pull: null })
  assert.deepEqual(runner.calls[0][1], ['worktree', 'show', '--worktree=path:/code/app wt', '--json'])
  assert.equal(await workspaceLinks('/code/app', fake(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))), null)
})
