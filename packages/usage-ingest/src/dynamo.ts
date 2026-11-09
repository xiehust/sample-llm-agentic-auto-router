// DynamoDB adapters for the ingest ports (low-level SDK v3 client, injected; tests pass a fake `send`).
import { BatchGetItemCommand, GetItemCommand, PutItemCommand, TransactWriteItemsCommand, type AttributeValue } from '@aws-sdk/client-dynamodb'
import { validatePolicy, type Policy } from '@auto-router/core'
import type { BudgetSetting, BudgetSource, Item, ItemKey, PolicySource, ResolvedConfig, TxAdd, TxOutcome, TxPut, UsageStore } from './types.ts'

/** Anything with the SDK client's `send` (DynamoDBClient in the Lambda, a fake in tests). */
export interface Sender { send(command: unknown): Promise<unknown> }

export function marshal(v: unknown): AttributeValue | undefined {
  if (v === undefined) return undefined
  if (v === null) return { NULL: true }
  if (typeof v === 'string') return { S: v }
  if (typeof v === 'boolean') return { BOOL: v }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number in an item')
    return { N: String(v) }
  }
  if (Array.isArray(v)) return { L: v.map(marshal).filter((x): x is AttributeValue => x !== undefined) }
  if (typeof v === 'object') return { M: marshalItem(v as Item) }
  throw new Error(`cannot store a ${typeof v}`)
}

export function marshalItem(item: Item): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {}
  for (const [k, v] of Object.entries(item)) {
    const m = marshal(v)
    if (m !== undefined) out[k] = m
  }
  return out
}

export function unmarshal(a: AttributeValue | undefined): unknown {
  if (!a) return undefined
  if ('S' in a && a.S !== undefined) return a.S
  if ('N' in a && a.N !== undefined) return Number(a.N)
  if ('BOOL' in a && a.BOOL !== undefined) return a.BOOL
  if ('NULL' in a && a.NULL) return null
  if ('L' in a && a.L) return a.L.map(unmarshal)
  if ('M' in a && a.M) return Object.fromEntries(Object.entries(a.M).map(([k, v]) => [k, unmarshal(v)]))
  return undefined
}

const keyOf = (k: ItemKey): Record<string, AttributeValue> => ({ pk: { S: k.pk }, sk: { S: k.sk } })
const RETRYABLE_CODES = new Set(['TransactionConflict', 'ThrottlingError', 'ProvisionedThroughputExceeded', 'RequestLimitExceeded', 'InternalServerError'])
const RETRYABLE_ERRORS = new Set(['ThrottlingException', 'ProvisionedThroughputExceededException', 'RequestLimitExceeded',
  'InternalServerError', 'TransactionInProgressException', 'TransactionConflictException', 'ServiceUnavailable'])

export function updateOf(table: string, a: TxAdd) {
  const names: Record<string, string> = { '#ttl': 'ttl' }
  const values: Record<string, AttributeValue> = { ':ttl': { N: String(a.ttl) } }
  const parts: string[] = []
  const sets = ['#ttl = if_not_exists(#ttl, :ttl)']
  Object.entries(a.add).forEach(([n, v], i) => {
    if (!Number.isSafeInteger(v)) throw new Error(`counter ${n} is not a safe integer`)
    names[`#c${i}`] = n
    values[`:c${i}`] = { N: String(v) }
    parts.push(`#c${i} :c${i}`)
  })
  Object.entries(a.set ?? {}).forEach(([n, v], i) => {
    names[`#s${i}`] = n
    values[`:s${i}`] = { S: v }
    sets.push(`#s${i} = :s${i}`)
  })
  return {
    TableName: table, Key: keyOf(a.key),
    UpdateExpression: `SET ${sets.join(', ')} ADD ${parts.join(', ')}`,
    ExpressionAttributeNames: names, ExpressionAttributeValues: values,
  }
}

export class DynamoUsageStore implements UsageStore {
  private readonly ddb: Sender
  private readonly table: string
  constructor(ddb: Sender, table: string) {
    this.ddb = ddb
    this.table = table
  }

  async transact(puts: TxPut[], adds: TxAdd[]): Promise<TxOutcome> {
    const items = [
      ...puts.map((p) => ({ Put: { TableName: this.table, Item: marshalItem(p.item), ConditionExpression: 'attribute_not_exists(pk)' } })),
      ...adds.map((a) => ({ Update: updateOf(this.table, a) })),
    ]
    if (items.length > 100) throw new Error(`transaction of ${items.length} items (max 100)`)
    try {
      await this.ddb.send(new TransactWriteItemsCommand({ TransactItems: items }))
      return { ok: true }
    } catch (e) {
      const err = e as { name?: string; CancellationReasons?: Array<{ Code?: string }> }
      if (err.name === 'TransactionCanceledException') {
        const reasons = err.CancellationReasons ?? []
        const duplicates = reasons.flatMap((r, i) => (i < puts.length && r?.Code === 'ConditionalCheckFailed' ? [i] : []))
        const retryable = reasons.some((r) => r?.Code !== undefined && RETRYABLE_CODES.has(r.Code)) || duplicates.length === 0
        return { ok: false, duplicates, retryable }
      }
      if (err.name && RETRYABLE_ERRORS.has(err.name)) return { ok: false, duplicates: [], retryable: true }
      throw e
    }
  }

  async getCounters(keys: ItemKey[]): Promise<Map<string, Record<string, number>>> {
    const out = new Map<string, Record<string, number>>()
    for (let i = 0; i < keys.length; i += 100) {
      let pending: Array<Record<string, AttributeValue>> | undefined = keys.slice(i, i + 100).map(keyOf)
      for (let attempt = 0; pending && pending.length > 0; attempt++) {
        if (attempt >= 6) throw new Error('BatchGetItem: unprocessed keys after 6 attempts')
        if (attempt > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt))
        const res = (await this.ddb.send(new BatchGetItemCommand({ RequestItems: { [this.table]: { Keys: pending } } }))) as {
          Responses?: Record<string, Array<Record<string, AttributeValue>>>
          UnprocessedKeys?: Record<string, { Keys?: Array<Record<string, AttributeValue>> }>
        }
        for (const it of res.Responses?.[this.table] ?? []) {
          const pk = it.pk?.S
          const sk = it.sk?.S
          if (!pk || !sk) continue
          const counters: Record<string, number> = {}
          for (const [k, v] of Object.entries(it)) if (v.N !== undefined && k !== 'ttl') counters[k] = Number(v.N)
          out.set(`${pk}|${sk}`, counters)
        }
        pending = res.UnprocessedKeys?.[this.table]?.Keys
      }
    }
    return out
  }

  async putLatest(item: Item & ItemKey & { ts: string }): Promise<'written' | 'stale'> {
    try {
      await this.ddb.send(new PutItemCommand({ TableName: this.table, Item: marshalItem(item),
        ConditionExpression: 'attribute_not_exists(#ts) OR #ts < :ts', ExpressionAttributeNames: { '#ts': 'ts' },
        ExpressionAttributeValues: { ':ts': { S: item.ts } } }))
      return 'written'
    } catch (e) {
      if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return 'stale'
      throw e // throttling and the like: the SDK has retried; the event is retried
    }
  }
}

/**
 * Sort key of a config version in the console table (0d effective-config §5): `0-baked.<sha8>` → `v#0#<sha8>` (the
 * baked document of one deploy-time content), legacy `0-baked` → `v#0`, `<n>-<suffix>` → `v#<n>`. Undefined when the
 * string is none of these.
 */
export function configSortKey(configVersion: string): string | undefined {
  const baked = /^0-baked\.([0-9a-f]{8})$/.exec(configVersion)
  if (baked) return `v#0#${baked[1]}`
  const n = configVersion.split('-')[0]
  return n && /^\d{1,12}$/.test(n) ? `v#${n}` : undefined
}

/**
 * Config documents in the console table (design §2.3a): pk `CONFIG`, sk from configSortKey(configVersion) (`v#<n>`,
 * the baked document `v#0#<sha8>`, legacy `v#0`), attribute `doc` = the document as a JSON string.
 * The line's policy must be the document's policy (policy.version === decision.policyVersion). Cached per Lambda
 * container: documents are immutable once written.
 */
export class DynamoPolicySource implements PolicySource {
  private readonly cache = new Map<string, { config?: ResolvedConfig; until: number }>()
  private readonly ddb: Sender
  private readonly table: string
  private readonly now: () => number
  constructor(ddb: Sender, table: string, now: () => number = Date.now) {
    this.ddb = ddb
    this.table = table
    this.now = now
  }

  async get(configVersion: string | undefined, policyVersion: string): Promise<ResolvedConfig | undefined> {
    if (!configVersion) return undefined // lines from a router without runtime config (pre-C3): no policy to resolve
    const hit = this.cache.get(configVersion)
    if (hit && hit.until > this.now()) return hit.config?.policy.version === policyVersion ? hit.config : undefined
    const sk = configSortKey(configVersion)
    let config: ResolvedConfig | undefined
    if (sk) {
      const res = (await this.ddb.send(new GetItemCommand({ TableName: this.table, Key: { pk: { S: 'CONFIG' }, sk: { S: sk } },
        ProjectionExpression: '#d', ExpressionAttributeNames: { '#d': 'doc' } }))) as { Item?: Record<string, AttributeValue> }
      const raw = res.Item?.doc?.S
      if (raw) {
        try {
          const doc = JSON.parse(raw) as { version?: unknown; policy?: unknown; assessor?: { threshold?: unknown } }
          if (doc.version === configVersion) {
            const policy: Policy = validatePolicy(doc.policy)
            const t = doc.assessor?.threshold
            config = { policy, ...(typeof t === 'number' && Number.isFinite(t) ? { assessorThreshold: t } : {}) }
          }
        } catch {
          config = undefined
        }
      }
    }
    if (this.cache.size > 64) this.cache.clear()
    this.cache.set(configVersion, { ...(config ? { config } : {}), until: config ? Number.POSITIVE_INFINITY : this.now() + 60_000 })
    return config?.policy.version === policyVersion ? config : undefined
  }
}

/** Budget settings: console items pk `MEMBER#<kind:id>` / `MEMBER#default`, sk `PROFILE`, attributes
 * `budgetMonthlyUsd` (N, or NULL for "no budget") and `budgetHardStop` (BOOL). */
export class DynamoBudgetSource implements BudgetSource {
  private readonly ddb: Sender
  private readonly table: string
  constructor(ddb: Sender, table: string) {
    this.ddb = ddb
    this.table = table
  }

  async get(principals: string[]): Promise<{ members: Map<string, BudgetSetting>; fallback?: BudgetSetting }> {
    const members = new Map<string, BudgetSetting>()
    let fallback: BudgetSetting | undefined
    const ids = [...principals, 'default']
    for (let i = 0; i < ids.length; i += 100) {
      let pending: Array<Record<string, AttributeValue>> | undefined = ids.slice(i, i + 100).map((p) => ({ pk: { S: `MEMBER#${p}` }, sk: { S: 'PROFILE' } }))
      for (let attempt = 0; pending && pending.length > 0; attempt++) {
        if (attempt >= 6) throw new Error('BatchGetItem: unprocessed keys after 6 attempts')
        if (attempt > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt))
        const res = (await this.ddb.send(new BatchGetItemCommand({ RequestItems: { [this.table]: { Keys: pending,
          ProjectionExpression: 'pk, budgetMonthlyUsd, budgetHardStop' } } }))) as {
          Responses?: Record<string, Array<Record<string, AttributeValue>>>
          UnprocessedKeys?: Record<string, { Keys?: Array<Record<string, AttributeValue>> }>
        }
        for (const it of res.Responses?.[this.table] ?? []) {
          const p = it.pk?.S?.slice('MEMBER#'.length)
          if (!p) continue
          const m = unmarshal(it.budgetMonthlyUsd)
          const h = unmarshal(it.budgetHardStop)
          const s: BudgetSetting = {
            ...(m === null || typeof m === 'number' ? { monthlyUsd: m } : {}),
            ...(typeof h === 'boolean' ? { hardStop: h } : {}),
          }
          if (p === 'default') fallback = s
          else members.set(p, s)
        }
        pending = res.UnprocessedKeys?.[this.table]?.Keys
      }
    }
    return { members, ...(fallback ? { fallback } : {}) }
  }
}
