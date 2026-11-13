// What the worker keeps of GitHub's answers, in memory for its lifetime, so the panel spends fewer
// of the GitHub budget it shares with Orca: answers for a short while (a TTL), one gh call for
// identical requests in flight, conditional REST reads (a 304 is free), and the budget left.
import { Conditional, GhError, type Gh, type RateLimit } from './gh'

/** How long an answer is kept: things that change (an item, its timeline, runs), and things that
 *  rarely do (labels, assignees, workflows). Both grow while the budget is low. */
export const SHORT_MS = 45_000
export const LONG_MS = 10 * 60_000
/** Below this share of the limit left, the budget is low. */
export const LOW_SHARE = 0.1
/** How much longer answers are kept, and runs polled, while the budget is low. */
export const LOW_TTL_FACTOR = 4
/** Answers kept at most; the oldest go first. */
export const MAX_ENTRIES = 300

const cancelled = () => new GhError('cancelled', 'The request was cancelled.')

type Entry = { tags: string[]; at: number; value?: unknown; pending?: Pending }
type Pending = { promise: Promise<unknown>; controller: AbortController; waiting: number }

/** `keep`: whether an answer may be kept (a run still going changes under the watch, so is not). */
export type ReadOptions = { tags: string[]; ttlMs: number; signal?: AbortSignal; keep?: (value: unknown) => boolean }

/** Answers by key, each dropped by any of its tags. */
export class Reads {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly now: () => number = Date.now,
    /** How many times longer than asked an answer is kept now (the budget may be low). */
    private readonly factor: () => number = () => 1
  ) {}

  /** The kept answer for `key` while it is younger than `ttlMs`; else `fetch`'s, shared with any
   *  identical read in flight. One caller giving up (its signal) leaves the others waiting; the gh
   *  call stops only when all of them gave up. Failures are not kept. */
  read<T>(key: string, options: ReadOptions, fetch: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const { signal } = options
    if (signal?.aborted) return Promise.reject(cancelled())
    const found = this.entries.get(key)
    if (found && 'value' in found && this.now() - found.at < options.ttlMs * this.factor()) return Promise.resolve(found.value as T)
    const entry = found?.pending ? found : this.start(key, options, fetch)
    // Everyone gave up: the call stops, and a read after that starts its own.
    const abandon = () => {
      entry.pending?.controller.abort()
      if (this.entries.get(key) === entry) this.entries.delete(key)
    }
    return this.wait(entry.pending!, abandon, signal) as Promise<T>
  }

  private start(key: string, { tags, keep }: ReadOptions, fetch: (signal: AbortSignal) => Promise<unknown>): Entry {
    const controller = new AbortController()
    const entry: Entry = { tags, at: 0 }
    const promise = fetch(controller.signal)
    entry.pending = { promise, controller, waiting: 0 }
    this.entries.delete(key)
    this.entries.set(key, entry)
    promise.then(
      (value) => {
        // Dropped meanwhile (a write, Refresh): the answer may be from before it, so it is not kept.
        if (this.entries.get(key) !== entry) return
        if (keep && !keep(value)) {
          this.entries.delete(key)
          return
        }
        delete entry.pending
        entry.value = value
        entry.at = this.now()
        this.trim()
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key)
      }
    )
    return entry
  }

  private wait(pending: Pending, abandon: () => void, signal?: AbortSignal): Promise<unknown> {
    pending.waiting++
    if (!signal) return pending.promise
    return new Promise((resolve, reject) => {
      let left = false
      const leave = () => {
        if (left) return
        left = true
        signal.removeEventListener('abort', gaveUp)
        pending.waiting--
      }
      const gaveUp = () => {
        leave()
        if (pending.waiting === 0) abandon()
        reject(cancelled())
      }
      signal.addEventListener('abort', gaveUp, { once: true })
      pending.promise.then(
        (value) => {
          leave()
          resolve(value)
        },
        (error: unknown) => {
          leave()
          reject(error)
        }
      )
    })
  }

  private trim(): void {
    for (const key of this.entries.keys()) {
      if (this.entries.size <= MAX_ENTRIES) return
      if (!this.entries.get(key)?.pending) this.entries.delete(key)
    }
  }

  /** Drops every answer with one of these tags, including reads still in flight: what they bring
   *  back is then not kept. */
  drop(...tags: string[]): void {
    for (const [key, entry] of this.entries) if (entry.tags.some((t) => tags.includes(t))) this.entries.delete(key)
  }

  /** Drops every answer whose tag starts with `prefix` (`items:`, every repo's items). */
  dropPrefix(prefix: string): void {
    for (const [key, entry] of this.entries) if (entry.tags.some((t) => t.startsWith(prefix))) this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}

/** The budget left, as the last REST answer said it; low below LOW_SHARE of the limit until its
 *  reset. Only REST answers carry it: GraphQL's budget is not read. */
export class Budget {
  private rate: RateLimit | null = null
  private reset: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly now: () => number = Date.now,
    /** Hears the budget each time what `shown` answers changes, and once more at its reset. */
    private readonly changed: (rate: RateLimit | null) => void = () => {},
    private readonly schedule: (run: () => void, ms: number) => ReturnType<typeof setTimeout> = (run, ms) => setTimeout(run, ms)
  ) {}

  see(rate: RateLimit | null): void {
    if (!rate || rate.resource !== 'core') return
    const before = JSON.stringify(this.shown())
    this.rate = rate
    const shown = this.shown()
    if (JSON.stringify(shown) === before) return
    this.changed(shown)
    if (this.reset) clearTimeout(this.reset)
    this.reset = null
    if (!shown) return
    // No answer may come at the reset, so the end of the low budget is told by the clock.
    this.reset = this.schedule(() => {
      this.reset = null
      this.changed(this.shown())
    }, Math.max(0, shown.resetAt - this.now()) + 1_000)
    ;(this.reset as { unref?: () => void })?.unref?.()
  }

  low(): boolean {
    return this.shown() !== null
  }

  /** The rate limit while it is low and not yet reset, else null. */
  shown(): RateLimit | null {
    const r = this.rate
    if (!r || r.limit <= 0 || this.now() >= r.resetAt) return null
    return r.remaining < r.limit * LOW_SHARE ? r : null
  }

  /** How many times longer answers are kept and runs polled now. */
  factor(): number {
    return this.low() ? LOW_TTL_FACTOR : 1
  }
}

/** A single REST GET (`gh api <path>`, no other flags): the reads that can be conditional. */
export function isPlainGet(args: string[]): boolean {
  return args.length === 2 && args[0] === 'api' && !args[1].startsWith('-') && args[1] !== 'graphql'
}

/** `gh` with conditional REST reads: each plain GET sends the ETag of its last answer, and a 304
 *  answers that body again without counting against the rate limit. Every answer's rate limit goes
 *  to `budget`. Other calls pass through. */
export function withEtags(gh: Gh, budget: (rate: RateLimit | null) => void, max = MAX_ENTRIES): Gh {
  const known = new Map<string, { etag: string; body: unknown }>()
  return async (args, options = {}) => {
    if (!options.json || !isPlainGet(args)) return gh(args, options)
    const key = `${options.cwd ?? ''}\n${args[1]}`
    const last = known.get(key)
    const out = await gh(args, { ...options, etag: last?.etag ?? null })
    // A runner that does not answer conditionally (a test's fake) answers the body itself.
    if (!(out instanceof Conditional)) return out
    budget(out.rate)
    if (out.status === 304 && last) return last.body
    if (out.status === 304) throw new GhError('gh_failed', 'GitHub said nothing changed, but nothing was kept.')
    known.delete(key)
    if (out.etag) known.set(key, { etag: out.etag, body: out.body })
    if (known.size > max) known.delete(known.keys().next().value!)
    return out.body
  }
}
