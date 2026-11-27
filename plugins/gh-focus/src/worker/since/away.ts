// When the person left each workspace, from Orca's focus (workspace.changed): coming back to one
// after AWAY_MS or more elsewhere is an absence, and the panel says what changed since. Kept in
// memory only, so a restart of Orca or of the worker forgets it.

/** How long focus must be elsewhere for a return to count as an absence. */
export const AWAY_MS = 10 * 60_000
/** Workspaces remembered at most; the one left longest ago goes first. */
export const AWAY_LIMIT = 100

export class Away {
  /** When focus last left each workspace not focused now. */
  private readonly left = new Map<string, number>()
  /** The start of each absence not yet dismissed, by workspace. */
  private readonly since = new Map<string, number>()
  private here: string | null = null

  constructor(private readonly now: () => number = Date.now) {}

  /** Focus moved to `id` (null: no workspace). Terminal changes repeat the same id and change
   *  nothing. An absence not yet dismissed keeps its start through later ones. */
  focus(id: string | null): void {
    if (id === this.here) return
    const at = this.now()
    // Taken before the one left is added, which may push the oldest out.
    const left = id ? this.left.get(id) : undefined
    if (id) this.left.delete(id)
    if (this.here) {
      this.left.delete(this.here)
      this.left.set(this.here, at)
      if (this.left.size > AWAY_LIMIT) {
        const oldest = this.left.keys().next().value!
        this.left.delete(oldest)
        this.since.delete(oldest)
      }
    }
    this.here = id
    if (id && left !== undefined && at - left >= AWAY_MS && !this.since.has(id)) this.since.set(id, left)
  }

  /** When the absence the person came back from began, or null. */
  sinceOf(id: string): number | null {
    return this.since.get(id) ?? null
  }

  dismiss(id: string): void {
    this.since.delete(id)
  }
}
