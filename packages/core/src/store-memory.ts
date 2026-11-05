import type { SessionState, StateStore } from './types.ts'

/**
 * Process-local StateStore. Values are cloned on the way in and out so callers can never mutate stored
 * state by accident. Least-recently-written entries are evicted beyond `maxEntries`.
 *
 * The root index (noteRoot) is bounded the same way: at most `maxEntries` roots (LRU; a put() of a lineage
 * under a known root refreshes it) and at most `maxLineagesPerRoot` lineages per root. The root's first
 * lineage is kept until the root itself is evicted, so its answer never flips; other lineages go oldest
 * noted first.
 */
export class InMemoryStateStore implements StateStore {
  private readonly map = new Map<string, SessionState>()
  private readonly roots = new Map<string, { first: string; others: Set<string> }>()
  private readonly maxEntries: number
  private readonly maxLineagesPerRoot: number

  constructor(opts: { maxEntries?: number; maxLineagesPerRoot?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? 100_000
    this.maxLineagesPerRoot = Math.max(1, opts.maxLineagesPerRoot ?? 64)
  }

  async get(lineage: string): Promise<SessionState | undefined> {
    const s = this.map.get(lineage)
    return s === undefined ? undefined : structuredClone(s)
  }

  async put(state: SessionState): Promise<void> {
    const key = state.key.lineage
    this.map.delete(key) // re-insert to refresh recency
    this.map.set(key, structuredClone(state))
    if (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    // An active session keeps its root in the index (noteRoot itself runs only for lineages without state).
    const r = this.roots.get(state.key.root)
    if (r !== undefined) {
      this.roots.delete(state.key.root)
      this.roots.set(state.key.root, r)
    }
  }

  /**
   * The answer is stable per (root, lineage): `rootSeen` says whether the root already had another lineage
   * when this lineage was first noted, `lineageSeen` whether this lineage was noted before. A retry of a
   * sub-agent's first call (its first call was not recorded, e.g. a 4xx) or concurrent first calls of one
   * sub-agent lineage therefore still read as new under a seen root, and the root's first lineage never does.
   */
  async noteRoot(root: string, lineage: string): Promise<{ rootSeen: boolean; lineageSeen: boolean }> {
    const known = this.roots.get(root)
    if (known === undefined) {
      this.roots.set(root, { first: lineage, others: new Set() })
      if (this.roots.size > this.maxEntries) {
        const oldest = this.roots.keys().next().value
        if (oldest !== undefined) this.roots.delete(oldest)
      }
      return { rootSeen: false, lineageSeen: false }
    }
    this.roots.delete(root) // re-insert to refresh recency
    this.roots.set(root, known)
    if (known.first === lineage) return { rootSeen: false, lineageSeen: true }
    const lineageSeen = known.others.has(lineage)
    known.others.delete(lineage) // re-insert to refresh recency
    known.others.add(lineage)
    if (known.others.size > this.maxLineagesPerRoot - 1) {
      const oldest = known.others.values().next().value
      if (oldest !== undefined) known.others.delete(oldest)
    }
    return { rootSeen: true, lineageSeen }
  }

  /** First lineage noted under `root` (read-only: no registration, no recency refresh). */
  async rootLineage(root: string): Promise<string | undefined> {
    return this.roots.get(root)?.first
  }

  get size(): number {
    return this.map.size
  }

  /** Number of roots in the root index (tests, metrics). */
  get rootCount(): number {
    return this.roots.size
  }
}
