// How a rejected plugin.request reads as a failed answer: Orca's own code is kept.
import { assert, hostError, test } from 'orca/testing'
import { requestFailed } from './store'

test('the codes the panel has words for are kept as Orca sent them', () => {
  for (const code of ['timeout', 'cancelled', 'rate_limited', 'too_large', 'unavailable', 'action_failed'] as const) {
    assert.deepEqual(requestFailed(hostError(code, 'it broke')), { ok: false, error: { code, message: 'it broke' } })
  }
})

test("Orca's rate limit keeps how long to wait", () => {
  assert.deepEqual(requestFailed(hostError('rate_limited', 'slow down', 12_000)).error, {
    code: 'rate_limited',
    message: 'slow down',
    retryAfterMs: 12_000
  })
})

test('any other Orca code is a broken request from the plugin: action_failed', () => {
  for (const code of ['invalid_params', 'unknown_method', 'capability_denied', 'some_new_code']) {
    assert.equal(requestFailed(hostError(code, 'x')).error.code, 'action_failed')
  }
})

test('a rejection with no code is still Orca not answering', () => {
  assert.deepEqual(requestFailed(new Error('port closed')).error, { code: 'host_failed', message: 'port closed' })
  assert.deepEqual(requestFailed('gone').error, { code: 'host_failed', message: 'gone' })
  assert.equal(requestFailed(undefined).error.code, 'host_failed')
})
