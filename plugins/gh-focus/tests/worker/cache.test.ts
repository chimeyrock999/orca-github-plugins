// The worker's read cache, the budget it reads from REST answers, and conditional REST reads.
import { assert, test } from 'orca/testing'
import { Budget, isPlainGet, LOW_TTL_FACTOR, MAX_ENTRIES, Reads, withEtags } from '../../src/worker/cache'
import { Conditional, GhError, type Gh, type RateLimit } from '../../src/worker/gh'

function clock(start = 1_000_000) {
  let at = start
  return { now: () => at, pass: (ms: number) => (at += ms) }
}

/** A fetch that counts its calls and answers `value` (or waits for `release`). */
function counted<T>(value: T) {
  let calls = 0
  let release: () => void = () => {}
  let gate: Promise<void> | null = null
  const fetch = async (signal: AbortSignal): Promise<T> => {
    calls++
    if (gate) {
      await Promise.race([gate, new Promise((_, reject) => signal.addEventListener('abort', () => reject(new GhError('cancelled', 'stopped'))))])
    }
    return value
  }
  return {
    fetch,
    calls: () => calls,
    hold() {
      gate = new Promise((resolve) => (release = resolve))
    },
    release: () => release()
  }
}

const rejected = (p: Promise<unknown>) => p.then(() => assert.fail('expected a rejection'), (e: unknown) => e as GhError)

test('an answer is kept for its TTL, then asked for again', async () => {
  const c = clock()
  const reads = new Reads(c.now)
  const f = counted('a')
  const opts = { tags: ['items:o/r'], ttlMs: 1_000 }
  assert.equal(await reads.read('k', opts, f.fetch), 'a')
  c.pass(999)
  assert.equal(await reads.read('k', opts, f.fetch), 'a')
  assert.equal(f.calls(), 1)
  c.pass(1)
  await reads.read('k', opts, f.fetch)
  assert.equal(f.calls(), 2)
})

test('the TTL grows by the factor while the budget is low', async () => {
  const c = clock()
  let factor = 1
  const reads = new Reads(c.now, () => factor)
  const f = counted('a')
  await reads.read('k', { tags: [], ttlMs: 1_000 }, f.fetch)
  factor = LOW_TTL_FACTOR
  c.pass(3_000)
  await reads.read('k', { tags: [], ttlMs: 1_000 }, f.fetch)
  assert.equal(f.calls(), 1)
})

test('single flight: identical reads in flight share one call', async () => {
  const reads = new Reads()
  const f = counted({ n: 1 })
  f.hold()
  const both = Promise.all([reads.read('k', { tags: [], ttlMs: 1_000 }, f.fetch), reads.read('k', { tags: [], ttlMs: 1_000 }, f.fetch)])
  f.release()
  const [a, b] = await both
  assert.equal(a, b)
  assert.equal(f.calls(), 1)
})

test('single flight: one caller giving up leaves the other its answer; all giving up stops the call', async () => {
  const reads = new Reads()
  const f = counted('a')
  f.hold()
  const first = new AbortController()
  const gaveUp = reads.read('k', { tags: [], ttlMs: 1_000, signal: first.signal }, f.fetch)
  const stays = reads.read('k', { tags: [], ttlMs: 1_000 }, f.fetch)
  first.abort()
  assert.equal((await rejected(gaveUp)).code, 'cancelled')
  f.release()
  assert.equal(await stays, 'a')
  assert.equal(f.calls(), 1)

  const g = counted('b')
  g.hold()
  const only = new AbortController()
  const alone = reads.read('j', { tags: [], ttlMs: 1_000, signal: only.signal }, g.fetch)
  only.abort()
  assert.equal((await rejected(alone)).code, 'cancelled')
  // The stopped call kept nothing: the next read asks again.
  const h = counted('c')
  assert.equal(await reads.read('j', { tags: [], ttlMs: 1_000 }, h.fetch), 'c')
})

test('failures are not kept', async () => {
  const reads = new Reads()
  let calls = 0
  const failing = async () => {
    calls++
    throw new GhError('gh_failed', 'no')
  }
  await rejected(reads.read('k', { tags: [], ttlMs: 1_000 }, failing))
  await rejected(reads.read('k', { tags: [], ttlMs: 1_000 }, failing))
  assert.equal(calls, 2)
})

test('drop: by tag or tag prefix, and a read in flight when dropped is not kept', async () => {
  const reads = new Reads()
  const f = counted('a')
  await reads.read('issue', { tags: ['items:o/r'], ttlMs: 1_000 }, f.fetch)
  await reads.read('labels', { tags: ['meta:o/r'], ttlMs: 1_000 }, f.fetch)
  await reads.read('other', { tags: ['items:o/x'], ttlMs: 1_000 }, f.fetch)
  reads.drop('items:o/r')
  assert.equal(reads.size, 2)
  reads.dropPrefix('items:')
  assert.equal(reads.size, 1)

  const g = counted('before the write')
  g.hold()
  const inFlight = reads.read('issue', { tags: ['items:o/r'], ttlMs: 1_000 }, g.fetch)
  reads.drop('items:o/r')
  g.release()
  assert.equal(await inFlight, 'before the write')
  const h = counted('after the write')
  assert.equal(await reads.read('issue', { tags: ['items:o/r'], ttlMs: 1_000 }, h.fetch), 'after the write')
})

test('clear drops everything, and the oldest answers go past the cap', async () => {
  const reads = new Reads()
  const f = counted('a')
  for (let i = 0; i < MAX_ENTRIES + 5; i++) await reads.read(`k${i}`, { tags: [], ttlMs: 1_000 }, f.fetch)
  assert.equal(reads.size, MAX_ENTRIES)
  reads.clear()
  assert.equal(reads.size, 0)
})

const rate = (remaining: number, resetAt = 2_000_000, resource = 'core'): RateLimit => ({ resource, limit: 5_000, remaining, resetAt })

test('budget: low under a tenth of the limit until the reset, told when that changes and at the reset', () => {
  const c = clock()
  const heard: (RateLimit | null)[] = []
  const timers: { run: () => void; ms: number }[] = []
  const budget = new Budget(c.now, (r) => heard.push(r), (run, ms) => {
    timers.push({ run, ms })
    return 0 as unknown as ReturnType<typeof setTimeout>
  })
  budget.see(rate(4_000))
  assert.equal(budget.low(), false)
  assert.deepEqual(heard, [])
  budget.see(rate(499))
  assert.equal(budget.low(), true)
  assert.equal(budget.factor(), LOW_TTL_FACTOR)
  budget.see(rate(498))
  // GraphQL's budget is not the one the panel reads.
  budget.see(rate(1, 2_000_000, 'graphql'))
  assert.deepEqual(heard.map((r: RateLimit | null) => r?.remaining ?? null), [499, 498])
  assert.equal(timers.at(-1)?.ms, 2_000_000 - 1_000_000 + 1_000)
  c.pass(1_000_001)
  timers.at(-1)!.run()
  assert.equal(budget.low(), false)
  assert.equal(heard[heard.length - 1], null)
})

test('plain GETs are the conditional reads', () => {
  assert.equal(isPlainGet(['api', 'repos/o/r/actions/runs/1']), true)
  assert.equal(isPlainGet(['api', 'graphql']), false)
  assert.equal(isPlainGet(['api', '-X', 'GET', 'repos/o/r/actions/runs']), false)
  assert.equal(isPlainGet(['api', '--paginate', '--slurp', 'repos/o/r/assignees']), false)
  assert.equal(isPlainGet(['run', 'view', '1']), false)
})

test('withEtags: sends the last ETag, answers the kept body on a 304, and passes each rate limit on', async () => {
  const sent: (string | null | undefined)[] = []
  let status: 200 | 304 = 200
  const gh: Gh = async (_args, options) => {
    sent.push(options?.etag)
    return status === 200 ? new Conditional(200, 'W/"1"', { id: 1 }, rate(4_000)) : new Conditional(304, 'W/"1"', null, rate(3_999))
  }
  const rates: (RateLimit | null)[] = []
  const conditional = withEtags(gh, (r) => rates.push(r))
  assert.deepEqual(await conditional(['api', 'repos/o/r/actions/runs/1'], { json: true, cwd: '/r' }), { id: 1 })
  status = 304
  assert.deepEqual(await conditional(['api', 'repos/o/r/actions/runs/1'], { json: true, cwd: '/r' }), { id: 1 })
  assert.deepEqual(sent, [null, 'W/"1"'])
  assert.deepEqual(rates.map((r) => r?.remaining), [4_000, 3_999])
})

test('withEtags: other calls, and a runner that answers plainly, pass through', async () => {
  const seen: unknown[] = []
  const gh: Gh = async (args, options) => {
    seen.push([args[1], options?.etag])
    return { plain: true }
  }
  const conditional = withEtags(gh, () => {})
  assert.deepEqual(await conditional(['api', 'graphql', '-f', 'query=x'], { json: true }), { plain: true })
  assert.deepEqual(await conditional(['api', 'repos/o/r'], { json: true }), { plain: true })
  assert.deepEqual(seen, [['graphql', undefined], ['repos/o/r', null]])
})
