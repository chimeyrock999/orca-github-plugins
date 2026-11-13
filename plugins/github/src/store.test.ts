// How a rejected plugin.request reads as a failed answer: Orca's own code is kept.
import { assert, hostError, test } from 'orca/testing'
import { requestFailed, unsure } from './store'

test('the codes the panel has words for are kept as Orca sent them', () => {
  for (const code of ['timeout', 'cancelled', 'too_large', 'unavailable', 'action_failed'] as const) {
    assert.deepEqual(requestFailed(hostError(code, 'it broke')), { ok: false, error: { code, message: 'it broke' } })
  }
})

test("a rejected rate limit is always Orca's (GitHub's comes as an answer), with or without a wait", () => {
  assert.deepEqual(requestFailed(hostError('rate_limited', 'slow down', 12_000)).error, {
    code: 'host_rate_limited',
    message: 'slow down',
    retryAfterMs: 12_000
  })
  assert.deepEqual(requestFailed(hostError('rate_limited', 'slow down')).error, { code: 'host_rate_limited', message: 'slow down' })
})

test("Orca's permission answers are not allowed, not a plugin bug", () => {
  for (const code of ['capability_denied', 'consent_required', 'not_permitted']) {
    assert.equal(requestFailed(hostError(code, 'x')).error.code, 'not_allowed', code)
  }
})

test('any other Orca code is a broken request from the plugin: action_failed', () => {
  for (const code of ['invalid_request', 'invalid_params', 'unknown_method', 'some_new_code', 'toString']) {
    assert.equal(requestFailed(hostError(code, 'x')).error.code, 'action_failed')
  }
})

test('a rejection with no code is still Orca not answering', () => {
  assert.deepEqual(requestFailed(new Error('port closed')).error, { code: 'host_failed', message: 'port closed' })
  assert.deepEqual(requestFailed('gone').error, { code: 'host_failed', message: 'gone' })
  assert.equal(requestFailed(undefined).error.code, 'host_failed')
})

test('a write Orca refused or held back did not run; one that broke on its way back may have landed', () => {
  const after = (code: string) => unsure(requestFailed(hostError(code, 'x')).error).code
  assert.deepEqual(
    ['capability_denied', 'rate_limited', 'timeout', 'cancelled', 'action_failed', 'too_large', 'unavailable'].map(after),
    ['not_allowed', 'host_rate_limited', 'unsure', 'unsure', 'unsure', 'unsure', 'unsure']
  )
})
