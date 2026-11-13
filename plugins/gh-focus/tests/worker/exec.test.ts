// terminalPath and currentBranch over a fake runner, and the PATH the worker runs commands with.
import { assert, test } from 'orca/testing'
import { delimiter } from 'node:path'
import { currentBranch, fallbackPath, parseTerminalShow, parseWorktreeShow, terminalPath, workspaceLinks, type Run, type RunResult } from '../../src/worker/exec'

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

// Trimmed from `orca worktree show --json` (Orca 1.4.256): the fields the panel reads.
const ctx = (repo: string) => ({ kind: 'task-source', provider: 'github', projectId: `github:${repo}`, providerIdentity: { provider: 'github', owner: repo.split('/')[0], repo: repo.split('/')[1] } })
const realShow = {
  ok: true,
  result: {
    worktree: {
      projectId: 'github:chimeyrock999/orca-github-plugins',
      linkedIssue: 22,
      linkedPR: null,
      linkedItems: [
        {
          provider: 'github',
          type: 'issue',
          number: 22,
          title: 'Lists show only the items linked to the focused workspace (no repo-wide lists)',
          url: 'https://github.com/chimeyrock999/orca-github-plugins/issues/22',
          taskSourceContext: ctx('chimeyrock999/orca-github-plugins')
        }
      ]
    }
  }
}

test('parseWorktreeShow reads every linked item, its repo from its URL, and the project', () => {
  assert.deepEqual(parseWorktreeShow(JSON.stringify(realShow)), {
    project: 'github:chimeyrock999/orca-github-plugins',
    items: [
      {
        type: 'issue',
        number: 22,
        repo: 'chimeyrock999/orca-github-plugins',
        title: 'Lists show only the items linked to the focused workspace (no repo-wide lists)',
        url: 'https://github.com/chimeyrock999/orca-github-plugins/issues/22',
        host: 'github.com'
      }
    ]
  })
  const show = (worktree: unknown) => JSON.stringify({ ok: true, result: { worktree } })
  const items = parseWorktreeShow(
    show({
      projectId: 'github:octo/app',
      linkedItems: [
        { provider: 'github', type: 'pr', number: 131, title: 'fix: export', url: 'https://github.com/octo/app/pull/131' },
        // Another repo, by URL; and one with no URL, by its task source.
        { provider: 'github', type: 'pr', number: 45, url: 'https://github.com/octo/sdk/pull/45' },
        { provider: 'github', type: 'issue', number: 7, taskSourceContext: ctx('octo/docs') },
        // Neither URL nor source: the workspace's own repo.
        { provider: 'github', type: 'issue', number: 8 },
        // A URL whose path is no repo name never becomes one.
        { provider: 'github', type: 'pr', number: 1, url: 'https://github.com/../../pull/1' },
        { provider: 'github', type: 'pr', number: 2, url: 'https://github.com/oc.to/app/pull/2' },
        // Not GitHub, not a number, not a kind the panel shows.
        { provider: 'linear', type: 'issue', number: 3, url: 'https://linear.app/acme/issue/STA-3' },
        { provider: 'github', type: 'issue', number: '9' },
        { provider: 'gitlab', type: 'mr', number: 2 },
        null
      ]
    })
  )
  assert.deepEqual(
    items?.items.map((i) => [i.type, i.number, i.repo]),
    [
      ['pull', 131, 'octo/app'],
      ['pull', 45, 'octo/sdk'],
      ['issue', 7, 'octo/docs'],
      ['issue', 8, null]
    ]
  )
  assert.equal(items?.items[0].title, 'fix: export')
  assert.equal(parseWorktreeShow(show({ projectId: 'github:acme/app', linkedItems: [{ provider: 'github', type: 'issue', number: 3, url: 'https://GHE.example.com/acme/app/issues/3' }] }))?.items[0].host, 'ghe.example.com')
  assert.equal(items?.items[1].title, null)
})

test('parseWorktreeShow: an Orca without linkedItems still gives its one linked issue and pull request', () => {
  const show = (worktree: unknown) => JSON.stringify({ ok: true, result: { worktree } })
  assert.deepEqual(parseWorktreeShow(show({ projectId: 'github:octo/app', linkedIssue: 4, linkedPR: null })), {
    project: 'github:octo/app',
    items: [{ type: 'issue', number: 4, repo: null, title: null, url: null, host: null }]
  })
  assert.deepEqual(parseWorktreeShow(show({ linkedIssue: '4', linkedPR: 131 })), { project: null, items: [{ type: 'pull', number: 131, repo: null, title: null, url: null, host: null }] })
  assert.equal(parseWorktreeShow('{"ok":false,"error":{"code":"selector_not_found"}}'), null)
  assert.equal(parseWorktreeShow('garbage'), null)
})

test('parseWorktreeShow: a legacy link the list does not have is added, as Orca adds it; one it has is not repeated', () => {
  const show = (worktree: unknown) => JSON.stringify({ ok: true, result: { worktree } })
  const listed = { provider: 'github', type: 'issue', number: 12, url: 'https://github.com/octo/app/issues/12' }
  assert.deepEqual(
    parseWorktreeShow(show({ projectId: 'github:octo/app', linkedIssue: 12, linkedPR: 30, linkedItems: [listed] }))?.items.map((i) => [i.type, i.number]),
    [
      ['issue', 12],
      ['pull', 30]
    ]
  )
  assert.deepEqual(parseWorktreeShow(show({ projectId: 'github:octo/app', linkedIssue: 12, linkedItems: [] }))?.items, [
    { type: 'issue', number: 12, repo: null, title: null, url: null, host: null }
  ])
})

test('workspaceLinks asks the CLI by path, and a CLI that will not run is null', async () => {
  const runner = fake({ code: 0, stdout: JSON.stringify({ ok: true, result: { worktree: { projectId: 'github:octo/app', linkedIssue: 4 } } }) })
  assert.deepEqual(await workspaceLinks('/code/app wt', runner), { project: 'github:octo/app', items: [{ type: 'issue', number: 4, repo: null, title: null, url: null, host: null }] })
  assert.deepEqual(runner.calls[0][1], ['worktree', 'show', '--worktree=path:/code/app wt', '--json'])
  assert.equal(await workspaceLinks('/code/app', fake(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))), null)
})

test('currentBranch: the upstream branch name when it tracks one, else its own; null when detached', async () => {
  const git = (answers: Record<string, RunResult>): Run => async (_cmd, args) => answers[args.join(' ')] ?? { code: 1, stdout: '', stderr: '' }
  const head = (name: string) => ({ 'rev-parse --abbrev-ref HEAD': { code: 0, stdout: `${name}\n`, stderr: '' } })
  assert.equal(await currentBranch('/w', git({ ...head('fix'), 'config --get branch.fix.merge': { code: 0, stdout: 'refs/heads/user/fix\n', stderr: '' } })), 'user/fix')
  assert.equal(await currentBranch('/w', git(head('feature/x'))), 'feature/x')
  assert.equal(await currentBranch('/w', git(head('HEAD'))), null)
  assert.equal(await currentBranch('/w', async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) }), null)
})
