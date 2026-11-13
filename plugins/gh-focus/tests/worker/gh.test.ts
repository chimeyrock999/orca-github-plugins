// runGh over a fake runner: arguments, JSON or text, and each failure's code.
import { assert, test } from 'orca/testing'
import { GhError, runGh } from '../../src/worker/gh'
import type { Run } from '../../src/worker/exec'

type Answer = { code: number; stdout?: string; stderr?: string } | Error

function fake(answer: Answer): Run & { calls: { cmd: string; args: string[]; cwd?: string; signal?: AbortSignal }[] } {
  const calls: { cmd: string; args: string[]; cwd?: string; signal?: AbortSignal }[] = []
  const runner: Run = async (cmd, args, options) => {
    calls.push({ cmd, args, cwd: options.cwd, signal: options.signal })
    if (answer instanceof Error) throw answer
    return { code: answer.code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }
  return Object.assign(runner, { calls })
}

function failed(error: Promise<unknown>): Promise<GhError> {
  return error.then(
    () => assert.fail('expected a GhError'),
    (e: unknown) => {
      assert.ok(e instanceof GhError, `not a GhError: ${String(e)}`)
      return e as GhError
    }
  )
}

function codeOf(stderr: string, code = 1): Promise<string> {
  return failed(runGh(['api', 'x'], { cwd: '/r' }, fake({ code, stderr }))).then((e) => e.code)
}

test('runs gh in the folder with the signal, and parses JSON when asked', async () => {
  const runner = fake({ code: 0, stdout: '{"a":1}\n' })
  const signal = new AbortController().signal
  assert.deepEqual(await runGh(['api', 'user'], { cwd: '/code/app', signal, json: true }, runner), { a: 1 })
  assert.deepEqual(runner.calls, [{ cmd: 'gh', args: ['api', 'user'], cwd: '/code/app', signal }])
})

test('answers text when JSON is not asked for', async () => {
  assert.equal(await runGh(['--version'], {}, fake({ code: 0, stdout: 'gh version 2\n' })), 'gh version 2\n')
})

test('output that is not JSON is gh_failed', async () => {
  const error = await failed(runGh(['api', 'x'], { json: true }, fake({ code: 0, stdout: '<html>' })))
  assert.equal(error.code, 'gh_failed')
})

test('gh not installed', async () => {
  const enoent = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
  assert.equal((await failed(runGh(['api', 'x'], {}, fake(enoent)))).code, 'gh_missing')
})

test('the caller gave up: cancelled', async () => {
  const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })
  assert.equal((await failed(runGh(['api', 'x'], {}, fake(abort)))).code, 'cancelled')
})

test('killed by the time limit: timeout', async () => {
  const killed = Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null })
  assert.equal((await failed(runGh(['api', 'x'], {}, fake(killed)))).code, 'timeout')
})

test('output past maxBuffer is gh_failed, not a timeout', async () => {
  const big = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true })
  assert.equal((await failed(runGh(['api', 'x'], {}, fake(big)))).code, 'gh_failed')
})

test('logged out, by exit code 4 or by message', async () => {
  assert.equal(await codeOf('To get started with GitHub CLI, please run:  gh auth login\n', 4), 'gh_logged_out')
  assert.equal(await codeOf('HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login\n'), 'gh_logged_out')
})

test('not a GitHub repository', async () => {
  assert.equal(await codeOf('failed to run git: fatal: not a git repository (or any of the parent directories): .git\n'), 'not_a_repo')
  assert.equal(await codeOf('none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`\n'), 'not_a_repo')
  assert.equal(await codeOf('no git remotes found\n'), 'not_a_repo')
})

test('not found', async () => {
  assert.equal(await codeOf('gh: Not Found (HTTP 404)\n'), 'not_found')
  assert.equal(await codeOf("GraphQL: Could not resolve to a Repository with the name 'octo/gone'. (repository)\n"), 'not_found')
})

test('rate limited, primary or secondary', async () => {
  assert.equal(await codeOf('gh: API rate limit exceeded for user ID 1. (HTTP 403)\n'), 'rate_limited')
  assert.equal(await codeOf('GraphQL: API rate limit already exceeded for user ID 1.\n'), 'rate_limited')
  assert.equal(await codeOf('gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)\n'), 'rate_limited')
})

test('anything else keeps gh stderr as the message', async () => {
  const error = await failed(runGh(['api', 'x'], {}, fake({ code: 1, stderr: 'gh: Server Error (HTTP 502)\n' })))
  assert.equal(error.code, 'gh_failed')
  assert.equal(error.message, 'gh: Server Error (HTTP 502)')
})

test('a failure with no stderr says the exit code', async () => {
  const error = await failed(runGh(['api', 'x'], {}, fake({ code: 3 })))
  assert.equal(error.message, 'gh exited with 3')
})

test('toFailure turns a GhError into a failed answer and rethrows anything else', async () => {
  const { toFailure } = await import('../../src/worker/gh')
  assert.deepEqual(toFailure(new GhError('not_found', 'gone')), { ok: false, error: { code: 'not_found', message: 'gone' } })
  assert.throws(() => toFailure(new TypeError('bug')), /bug/)
})

test('partial: a GraphQL answer that only misses things or is refused some keeps its data; anything else still fails', async () => {
  const missing = JSON.stringify({ data: { r0: { n1: { number: 1 }, n9: null } }, errors: [{ type: 'NOT_FOUND', path: ['r0', 'n9'], message: 'Could not resolve' }] })
  assert.deepEqual(await runGh(['api', 'graphql'], { json: true, partial: true }, fake({ code: 1, stdout: missing, stderr: 'Could not resolve' })), JSON.parse(missing))
  // Without partial, the same answer is not_found.
  assert.equal((await failed(runGh(['api', 'graphql'], { json: true }, fake({ code: 1, stdout: missing, stderr: 'Could not resolve to an issue' })))).code, 'not_found')
  const saml = JSON.stringify({ data: { r0: null }, errors: [{ type: 'FORBIDDEN', message: 'SAML enforcement' }] })
  assert.deepEqual(await runGh(['api', 'graphql'], { json: true, partial: true }, fake({ code: 1, stdout: saml, stderr: 'SAML' })), JSON.parse(saml))
  const odd = JSON.stringify({ data: { r0: null }, errors: [{ type: 'INTERNAL', message: 'no' }] })
  assert.equal((await failed(runGh(['api', 'graphql'], { json: true, partial: true }, fake({ code: 1, stdout: odd, stderr: 'no' })))).code, 'gh_failed')
  assert.equal((await failed(runGh(['api', 'graphql'], { json: true, partial: true }, fake({ code: 4, stdout: '', stderr: 'gh auth login' })))).code, 'gh_logged_out')
})
