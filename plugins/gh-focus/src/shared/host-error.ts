// What a rejected Orca call means to the panel. Both sides use it: the panel for a rejected
// plugin.request, the worker for a host call it answers about (commands.run).
import type { ErrorCode, PanelError } from './protocol'

// Kept where the panel has words for them, Orca's permission answers as not_allowed, and its rate
// limit as its own (GitHub's comes as an answer, never a rejection). Any other code is a request
// the plugin got wrong, which Orca's typings say to treat as action_failed.
const HOST_CODES = new Map<string, ErrorCode>([
  ['timeout', 'timeout'],
  ['cancelled', 'cancelled'],
  ['too_large', 'too_large'],
  ['unavailable', 'unavailable'],
  ['action_failed', 'action_failed'],
  ['rate_limited', 'host_rate_limited'],
  ['capability_denied', 'not_allowed'],
  ['consent_required', 'not_allowed'],
  ['not_permitted', 'not_allowed']
])

/** A rejected Orca call as a panel error, keeping what Orca's code means; one with no code is Orca
 *  not answering. */
export function hostFailure(error: unknown): PanelError {
  const e = error as { code?: unknown; message?: unknown; retryAfterMs?: unknown }
  const code: ErrorCode = typeof e?.code !== 'string' ? 'host_failed' : (HOST_CODES.get(e.code) ?? 'action_failed')
  const failure: PanelError = { code, message: String(e?.message ?? error) }
  if (typeof e?.retryAfterMs === 'number') failure.retryAfterMs = e.retryAfterMs
  return failure
}
