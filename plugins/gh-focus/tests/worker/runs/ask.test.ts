// The prompt the workspace's agent is asked to fix a failed run with.
import { assert, test } from 'orca/testing'
import { GhError } from '../../../src/worker/gh'
import { fixRunPrompt } from '../../../src/worker/runs/ask'
import type { RunJob } from '../../../src/shared/protocol'
import { runDetail } from '../../fixtures/fixtures'

const repo = { nameWithOwner: 'octo/app', path: '/code/app' }
const failed = (id: number, name: string): RunJob => ({ ...runDetail().jobs[1], id, name })

test('the prompt names the run, its failed jobs and the gh command for their log, on one line', () => {
  const run = runDetail()
  assert.equal(
    fixRunPrompt(repo, run),
    `Fix the failed GitHub Actions run ${run.url} (${run.workflow} #${run.runNumber}; failed jobs: test (ubuntu-latest)). Read its failed log with: gh run view ${run.id} --log-failed -R octo/app`
  )
})

test('a few failed jobs are named and the rest counted; none leaves the list out', () => {
  const jobs = (n: number) => runDetail({ jobs: [runDetail().jobs[0], ...Array.from({ length: n }, (_, i) => failed(600 + i, `job ${i + 1}`))] })
  assert.match(fixRunPrompt(repo, jobs(3)), /failed jobs: job 1, job 2, job 3\)/)
  assert.match(fixRunPrompt(repo, jobs(5)), /failed jobs: job 1, job 2, job 3, \+2 more\)/)
  const none = fixRunPrompt(repo, jobs(0))
  assert.ok(!none.includes('failed jobs'))
  assert.ok(none.includes(' #296)'))
})

test('names from GitHub cannot break the line: control characters become spaces', () => {
  const text = fixRunPrompt(repo, runDetail({ workflow: 'CI\r\nnext', jobs: [failed(601, 'build\n\u001b[31mlinux\t')] }))
  assert.ok(!/[\u0000-\u001f]/.test(text))
  assert.match(text, /\(CI next #296; failed jobs: build \[31mlinux\)/)
})

test('a run that is still going, passed or was cancelled is refused', () => {
  for (const run of [runDetail({ done: false, state: 'running' }), runDetail({ state: 'success' }), runDetail({ state: 'cancelled' })]) {
    assert.throws(() => fixRunPrompt(repo, run), (e: unknown) => e instanceof GhError && e.code === 'gh_failed')
  }
})
