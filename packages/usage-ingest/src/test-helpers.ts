// In-memory fakes of the ingest ports, with DynamoDB's transaction rules enforced (≤ 100 items, one entry per key,
// conditional puts all-or-nothing).
import { gzipSync } from 'node:zlib'
import type { Policy } from '@auto-router/core'
import type { DecodedPayload } from './parse.ts'
import type { BlocksStore, BudgetBlocksDoc, BudgetSetting, BudgetSource, Item, ItemKey, PolicySource, TxAdd, TxOutcome, TxPut, UsageStore } from './types.ts'

const k = (x: ItemKey): string => `${x.pk}|${x.sk}`

export class FakeStore implements UsageStore {
  readonly items = new Map<string, Item>()
  readonly counters = new Map<string, Record<string, number>>()
  readonly sets = new Map<string, Record<string, string>>()
  readonly ttls = new Map<string, number>()
  readonly txSizes: number[] = []
  failures: Array<'conflict'> = []

  async transact(puts: TxPut[], adds: TxAdd[]): Promise<TxOutcome> {
    const keys = [...puts.map((p) => k(p.item)), ...adds.map((a) => k(a.key))]
    if (keys.length > 100) throw new Error(`transaction of ${keys.length} items`)
    if (new Set(keys).size !== keys.length) throw new Error('an item appears twice in one transaction')
    if (this.failures.shift() === 'conflict') return { ok: false, duplicates: [], retryable: true }
    const duplicates = puts.flatMap((p, i) => (this.items.has(k(p.item)) ? [i] : []))
    if (duplicates.length) return { ok: false, duplicates, retryable: false }
    this.txSizes.push(keys.length)
    for (const p of puts) this.items.set(k(p.item), structuredClone(p.item))
    for (const a of adds) {
      const c = this.counters.get(k(a.key)) ?? {}
      for (const [n, v] of Object.entries(a.add)) c[n] = (c[n] ?? 0) + v
      this.counters.set(k(a.key), c)
      if (!this.ttls.has(k(a.key))) this.ttls.set(k(a.key), a.ttl)
      if (a.set) this.sets.set(k(a.key), { ...this.sets.get(k(a.key)), ...a.set })
    }
    return { ok: true }
  }

  async putLatest(item: Item & ItemKey & { ts: string }): Promise<'written' | 'stale'> {
    const cur = this.items.get(k(item))
    if (cur && typeof cur.ts === 'string' && !(cur.ts < item.ts)) return 'stale'
    this.items.set(k(item), structuredClone(item))
    return 'written'
  }

  async getCounters(keys: ItemKey[]): Promise<Map<string, Record<string, number>>> {
    const out = new Map<string, Record<string, number>>()
    for (const key of keys) {
      const c = this.counters.get(k(key))
      if (c) out.set(k(key), { ...c })
    }
    return out
  }

  /** Sum of one counter over every rollup item whose pk starts with `prefix`. */
  sum(prefix: string, name: string): number {
    let s = 0
    for (const [key, c] of this.counters) if (key.startsWith(prefix)) s += c[name] ?? 0
    return s
  }

  records(): Item[] {
    return [...this.items.entries()].filter(([key]) => key.startsWith('P#')).map(([, v]) => v)
  }
}

export const mapPolicies = (byVersion: Record<string, Policy>, assessorThreshold?: number): PolicySource => ({
  get: async (_cv, pv) => {
    const policy = byVersion[pv]
    return policy ? { policy, ...(assessorThreshold !== undefined ? { assessorThreshold } : {}) } : undefined
  },
})

export class FakeBlocks implements BlocksStore {
  doc?: BudgetBlocksDoc
  etag = 0
  writes = 0
  conflictsLeft = 0
  async read() {
    return this.doc ? { doc: structuredClone(this.doc), etag: `"${this.etag}"` } : undefined
  }
  async write(doc: BudgetBlocksDoc, etag: string | undefined): Promise<'ok' | 'conflict'> {
    if (this.conflictsLeft > 0) {
      this.conflictsLeft -= 1
      this.etag += 1 // someone else wrote meanwhile
      return 'conflict'
    }
    if ((etag === undefined) !== (this.doc === undefined) || (etag !== undefined && etag !== `"${this.etag}"`)) return 'conflict'
    this.doc = structuredClone(doc)
    this.etag += 1
    this.writes += 1
    return 'ok'
  }
}

export class FakeBudgets implements BudgetSource {
  members: Record<string, BudgetSetting>
  fallback?: BudgetSetting
  constructor(members: Record<string, BudgetSetting> = {}, fallback?: BudgetSetting) {
    this.members = members
    if (fallback) this.fallback = fallback
  }
  async get(principals: string[]) {
    const members = new Map<string, BudgetSetting>()
    for (const p of principals) if (this.members[p]) members.set(p, this.members[p])
    return { members, ...(this.fallback ? { fallback: this.fallback } : {}) }
  }
}

export function payload(lines: unknown[], logStream = 'router/router/0123abcd'): DecodedPayload {
  return {
    messageType: 'DATA_MESSAGE', logGroup: '/llmar/router', logStream,
    logEvents: lines.map((l, i) => ({ id: String(i), timestamp: 0, message: typeof l === 'string' ? l : JSON.stringify(l) })),
  }
}

/** The subscription event Lambda receives: { awslogs: { data: base64(gzip(json)) } }. */
export function awslogsEvent(p: DecodedPayload): { awslogs: { data: string } } {
  return { awslogs: { data: gzipSync(Buffer.from(JSON.stringify(p))).toString('base64') } }
}
