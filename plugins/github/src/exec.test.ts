// terminalPath over a fake runner, and the PATH the worker runs commands with.
import { assert, test } from 'orca/testing'
import { delimiter } from 'node:path'
import { fallbackPath, parseTerminalShow, terminalPath, type Run } from './exec'

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
