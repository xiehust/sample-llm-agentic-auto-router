// DynamoDB adapters for the console and usage tables (design v1 §2.3 / §2.3a, 17's usage-ingest records.ts).
//   console: CONFIG/v#<n> {doc: JSON, meta}, CONFIG/ACTIVE {version, delivered}, CONFIG/DRAFT {doc, …},
//            MEMBER#<kind:id>/PROFILE and MEMBER#default/PROFILE (flat: status, role, budgetMonthlyUsd|NULL,
//            budgetAlertAt, budgetHardStop, cap, name, description, createdAt, updatedAt),
//            AUDIT#<yyyy-mm>/<ts>#<id> {entry: JSON}, SETTINGS/DEPLOYMENT, IDENTITY/DELIVERY.
//   usage:   P#<principal>/T#<ts>#<reqId> records (gsi1 D#<day>, gsi2 S#<principal>#<session>), U#<principal>#<month>
//            and A#<month> daily rollups, B#<principal>#<month>/TOTAL spend, C#config/<ts>#<task> router reports.
// Paging cursors are base64url JSON of DynamoDB's LastEvaluatedKey plus scope; a cursor whose partition does not
// match the query's scope is refused (members can never page another principal, design §2.3a).
import {
  BatchGetItemCommand, GetItemCommand, PutItemCommand, QueryCommand, ScanCommand, TransactWriteItemsCommand, DeleteItemCommand,
  type AttributeValue, type QueryCommandInput,
} from '@aws-sdk/client-dynamodb'
import type { AuditEntry, Budget, DeploymentSettings, Page } from '@auto-router/console-contract'
import { HttpError } from '../http.ts'
import { versionNumber } from '../config-doc.ts'
import type { Delivery, StoredVersion } from '../local-types.ts'
import type {
  ActivePointer, AuditQuery, ConfigReport, ConsoleStore, Draft, MemberSettings, RecordScan, RollupItem, StateReport, StoredRecord, UsageStore,
} from '../ports.ts'

/** The one method the adapters use (DynamoDBClient satisfies it; tests pass a fake). */
export interface Sender { send(command: unknown): Promise<any> }
type Item = Record<string, AttributeValue>

// ---------------------------------------------------------------- marshalling (plain JSON values)

export function toAttr(v: unknown): AttributeValue | undefined {
  if (v === undefined) return undefined
  if (v === null) return { NULL: true }
  if (typeof v === 'string') return { S: v }
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('non-finite number'); return { N: String(v) } }
  if (typeof v === 'boolean') return { BOOL: v }
  if (Array.isArray(v)) return { L: v.map((x) => toAttr(x) ?? { NULL: true }) }
  if (typeof v === 'object') return { M: toItem(v as Record<string, unknown>) }
  throw new Error(`cannot marshal ${typeof v}`)
}
export function toItem(o: Record<string, unknown>): Item {
  const out: Item = {}
  for (const [k, v] of Object.entries(o)) { const a = toAttr(v); if (a) out[k] = a }
  return out
}
export function fromAttr(a: AttributeValue): unknown {
  if ('S' in a && a.S !== undefined) return a.S
  if ('N' in a && a.N !== undefined) return Number(a.N)
  if ('BOOL' in a && a.BOOL !== undefined) return a.BOOL
  if ('NULL' in a && a.NULL) return null
  if ('L' in a && a.L) return a.L.map(fromAttr)
  if ('M' in a && a.M) return fromItem(a.M)
  if ('SS' in a && a.SS) return [...a.SS]
  if ('NS' in a && a.NS) return a.NS.map(Number)
  return undefined
}
export function fromItem(i: Item): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(i)) out[k] = fromAttr(v)
  return out
}
const key = (pk: string, sk: string): Item => ({ pk: { S: pk }, sk: { S: sk } })

// ---------------------------------------------------------------- cursors

/** A cursor: scope, DynamoDB's LastEvaluatedKey (optional: a multi-partition walk may resume at a partition start), extras. */
export function encodeCursor(scope: string, lek: Item | undefined, extra: Record<string, unknown> = {}): string | undefined {
  if (!lek && Object.keys(extra).length === 0) return undefined
  return Buffer.from(JSON.stringify({ s: scope, ...(lek ? { k: fromItem(lek) } : {}), ...extra })).toString('base64url')
}
/**
 * Decodes a cursor; 400 unless its scope matches and the partition key of the index the query uses (`pkName`)
 * passes `pkOk`, the caller's scope (design §2.3a).
 */
export function decodeCursor(scope: string, cursor: string | undefined, pkName: 'pk' | 'gsi1pk' | 'gsi2pk', pkOk: (pk: string) => boolean): { lek?: Item; extra: Record<string, unknown> } {
  if (cursor === undefined) return { extra: {} }
  const bad = () => new HttpError(400, 'bad-request', 'cursor: not valid here')
  let c: { s?: unknown; k?: unknown } & Record<string, unknown>
  try { c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as typeof c } catch { throw bad() }
  if (typeof c !== 'object' || c === null || c.s !== scope) throw bad()
  const { s: _, k, ...extra } = c
  if (k === undefined) return { extra }
  const o = k as Record<string, unknown>
  const pk = o[pkName]
  if (typeof o !== 'object' || typeof pk !== 'string' || !pkOk(pk) || typeof o.pk !== 'string' || typeof o.sk !== 'string') throw bad()
  // A base-table cursor carries base keys only (no index keys that a different query could act on).
  if (pkName === 'pk' && (o.gsi1pk !== undefined || o.gsi2pk !== undefined)) throw bad()
  return { lek: toItem(o), extra }
}

async function queryAll(db: Sender, input: QueryCommandInput, maxItems = 10_000): Promise<Item[]> {
  const out: Item[] = []
  let lek: Item | undefined
  do {
    const r = await db.send(new QueryCommand({ ...input, ...(lek ? { ExclusiveStartKey: lek } : {}) }))
    out.push(...((r.Items ?? []) as Item[]))
    lek = r.LastEvaluatedKey as Item | undefined
  } while (lek && out.length < maxItems)
  return out
}

const TXN_CANCELLED = new Set(['TransactionCanceledException', 'ConditionalCheckFailedException'])

// ---------------------------------------------------------------- console table

const META_FIELDS = ['version', 'n', 'author', 'createdAt', 'comment', 'changed', 'rollbackOf'] as const

export class DynamoConsoleStore implements ConsoleStore {
  private readonly db: Sender
  private readonly table: string
  constructor(db: Sender, table: string) { this.db = db; this.table = table }

  private async get(pk: string, sk: string): Promise<Record<string, unknown> | undefined> {
    const r = await this.db.send(new GetItemCommand({ TableName: this.table, Key: key(pk, sk), ConsistentRead: true }))
    return r.Item ? fromItem(r.Item as Item) : undefined
  }
  private async put(o: Record<string, unknown>): Promise<void> {
    await this.db.send(new PutItemCommand({ TableName: this.table, Item: toItem(o) }))
  }

  async getActive(): Promise<ActivePointer | undefined> {
    const a = await this.get('CONFIG', 'ACTIVE')
    const version = a?.version
    const n = versionNumber(version)
    if (typeof version !== 'string' || n === undefined) return undefined
    // The seeded baked version (0) has no delivery state: the router runs the CDK-baked policy without an object.
    return { n, version, delivered: typeof a?.delivered === 'boolean' ? a.delivered : true }
  }
  async getVersion(n: number): Promise<StoredVersion | undefined> {
    const v = await this.get('CONFIG', `v#${n}`)
    if (!v || typeof v.doc !== 'string') return undefined
    const document = JSON.parse(v.doc) as StoredVersion['document']
    const version = typeof v.version === 'string' ? v.version : document.version
    return {
      meta: {
        version, n, author: typeof v.author === 'string' ? v.author : 'cdk', createdAt: typeof v.createdAt === 'string' ? v.createdAt : '',
        comment: typeof v.comment === 'string' ? v.comment : '', changed: Array.isArray(v.changed) ? (v.changed as string[]) : [],
        ...(typeof v.rollbackOf === 'string' ? { rollbackOf: v.rollbackOf } : {}),
      },
      document,
    }
  }
  private async metas(): Promise<StoredVersion['meta'][]> {
    // sk `v#<n>` is not zero-padded (frozen): read every version's metadata (no doc) and order by n numerically.
    // Baked seeds (v#0#<sha8>) are not console versions and are skipped below.
    const items = await queryAll(this.db, {
      TableName: this.table, KeyConditionExpression: 'pk = :p AND begins_with(sk, :v)', ExpressionAttributeValues: { ':p': { S: 'CONFIG' }, ':v': { S: 'v#' } },
      ProjectionExpression: ['sk', ...META_FIELDS].map((f) => `#${f}`).join(', '),
      ExpressionAttributeNames: Object.fromEntries(['sk', ...META_FIELDS].map((f) => [`#${f}`, f])),
    })
    return items.map(fromItem).flatMap((v) => {
      const n = Number(String(v.sk).slice(2))
      if (!/^v#\d+$/.test(String(v.sk)) || !Number.isInteger(n)) return []
      return [{
        version: typeof v.version === 'string' ? v.version : `${n}`, n, author: typeof v.author === 'string' ? v.author : 'cdk',
        createdAt: typeof v.createdAt === 'string' ? v.createdAt : '', comment: typeof v.comment === 'string' ? v.comment : '',
        changed: Array.isArray(v.changed) ? (v.changed as string[]) : [], ...(typeof v.rollbackOf === 'string' ? { rollbackOf: v.rollbackOf } : {}),
      }]
    }).sort((a, b) => b.n - a.n)
  }
  async listVersionMetas(limit: number, before?: number) { return (await this.metas()).filter((m) => before === undefined || m.n < before).slice(0, limit) }
  async latestVersion() { return (await this.metas())[0]?.n ?? 0 }
  async seedBakedVersion(sha8: string, v: StoredVersion): Promise<void> {
    try {
      await this.db.send(new PutItemCommand({
        TableName: this.table, ConditionExpression: 'attribute_not_exists(pk)',
        Item: toItem({ pk: 'CONFIG', sk: `v#0#${sha8}`, doc: JSON.stringify(v.document), ...v.meta }),
      }))
    } catch (e) {
      if (!(e instanceof Error && e.name === 'ConditionalCheckFailedException')) throw e // already seeded: immutable
    }
  }
  async getBakedVersion(sha8: string): Promise<StoredVersion | undefined> {
    const v = await this.get('CONFIG', `v#0#${sha8}`)
    if (!v || typeof v.doc !== 'string') return undefined
    const document = JSON.parse(v.doc) as StoredVersion['document']
    return { meta: { version: document.version, n: 0, author: 'cdk', createdAt: typeof v.createdAt === 'string' ? v.createdAt : '', comment: typeof v.comment === 'string' ? v.comment : '', changed: [] }, document }
  }
  async activate(v: StoredVersion, expectVersion: string | undefined): Promise<'ok' | 'conflict'> {
    try {
      await this.db.send(new TransactWriteItemsCommand({
        TransactItems: [
          { Put: { TableName: this.table, Item: toItem({ pk: 'CONFIG', sk: `v#${v.meta.n}`, doc: JSON.stringify(v.document), ...v.meta }), ConditionExpression: 'attribute_not_exists(pk)' } },
          {
            Put: expectVersion === undefined
              ? { TableName: this.table, Item: toItem({ pk: 'CONFIG', sk: 'ACTIVE', version: v.meta.version, delivered: false }), ConditionExpression: 'attribute_not_exists(pk)' }
              : {
                TableName: this.table, Item: toItem({ pk: 'CONFIG', sk: 'ACTIVE', version: v.meta.version, delivered: false }),
                ConditionExpression: '#v = :expect', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':expect': { S: expectVersion } },
              },
          },
        ],
      }))
      return 'ok'
    } catch (e) {
      if (e instanceof Error && TXN_CANCELLED.has(e.name)) return 'conflict'
      throw e
    }
  }
  async markDelivered(n: number, delivered: boolean): Promise<void> {
    const a = await this.getActive()
    if (!a || a.n !== n) return
    try {
      await this.db.send(new PutItemCommand({
        TableName: this.table, Item: toItem({ pk: 'CONFIG', sk: 'ACTIVE', version: a.version, delivered }),
        ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': { S: a.version } },
      }))
    } catch (e) {
      if (!(e instanceof Error && e.name === 'ConditionalCheckFailedException')) throw e // ACTIVE moved on: nothing to mark
    }
  }
  async getDraft(): Promise<Draft | undefined> {
    const d = await this.get('CONFIG', 'DRAFT')
    if (!d || typeof d.doc !== 'string') return undefined
    return { document: JSON.parse(d.doc) as Draft['document'], author: String(d.author ?? ''), updatedAt: String(d.updatedAt ?? ''), baseVersion: String(d.baseVersion ?? '') }
  }
  async putDraft(d: Draft) { await this.put({ pk: 'CONFIG', sk: 'DRAFT', doc: JSON.stringify(d.document), author: d.author, updatedAt: d.updatedAt, baseVersion: d.baseVersion }) }
  async deleteDraft() { await this.db.send(new DeleteItemCommand({ TableName: this.table, Key: key('CONFIG', 'DRAFT') })) }

  async appendAudit(e: AuditEntry) { await this.put({ pk: `AUDIT#${e.ts.slice(0, 7)}`, sk: `${e.ts}#${e.id}`, entry: JSON.stringify(e) }) }
  async listAudit(q: AuditQuery): Promise<Page<AuditEntry>> {
    // Newest first across the months of [from, to); the cursor carries the month and DynamoDB's position in it.
    const months: string[] = []
    for (let m = q.to.slice(0, 7); m >= q.from.slice(0, 7); m = prevMonth(m)) months.push(m)
    const c = decodeCursor('audit', q.cursor, 'pk', (pk) => pk.startsWith('AUDIT#'))
    let mi = typeof c.extra.m === 'string' ? Math.max(0, months.indexOf(c.extra.m)) : 0
    let lek = c.lek
    const items: AuditEntry[] = []
    while (mi < months.length && items.length < q.limit) {
      const r = await this.db.send(new QueryCommand({
        TableName: this.table, KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b', ScanIndexForward: false, Limit: 100,
        ExpressionAttributeValues: { ':p': { S: `AUDIT#${months[mi]}` }, ':a': { S: q.from }, ':b': { S: q.to } }, ...(lek ? { ExclusiveStartKey: lek } : {}),
      }))
      for (const it of (r.Items ?? []) as Item[]) {
        const e = JSON.parse(String(fromItem(it).entry)) as AuditEntry
        if (e.ts >= q.to || e.ts < q.from) continue
        if (q.actor && e.actor.key !== q.actor && e.actor.kind !== q.actor) continue
        if (q.actions && !q.actions.includes(e.action)) continue
        if (q.target && e.target !== q.target) continue
        items.push(e)
      }
      lek = r.LastEvaluatedKey as Item | undefined
      if (!lek) mi += 1
      if (items.length >= q.limit) break
    }
    const next = mi < months.length ? encodeCursor('audit', lek, { m: months[mi] }) : undefined
    return { items: items.slice(0, q.limit), ...(next ? { nextCursor: next } : {}) }
  }

  async getMember(k: string) { const m = await this.get(`MEMBER#${k}`, 'PROFILE'); return m ? memberFrom(k, m) : undefined }
  async putMember(m: MemberSettings) { await this.put({ pk: `MEMBER#${m.key}`, sk: 'PROFILE', ...memberTo(m) }) }
  async deleteMember(k: string) { await this.db.send(new DeleteItemCommand({ TableName: this.table, Key: key(`MEMBER#${k}`, 'PROFILE') })) }
  async listMembers(): Promise<MemberSettings[]> {
    const out: MemberSettings[] = []
    let lek: Item | undefined
    do {
      const r = await this.db.send(new ScanCommand({
        TableName: this.table, FilterExpression: 'begins_with(pk, :m) AND sk = :p AND pk <> :d',
        ExpressionAttributeValues: { ':m': { S: 'MEMBER#' }, ':p': { S: 'PROFILE' }, ':d': { S: 'MEMBER#default' } }, ...(lek ? { ExclusiveStartKey: lek } : {}),
      }))
      for (const it of (r.Items ?? []) as Item[]) { const o = fromItem(it); out.push(memberFrom(String(o.pk).slice('MEMBER#'.length), o)) }
      lek = r.LastEvaluatedKey as Item | undefined
    } while (lek)
    return out
  }
  async getDefaultBudget() { const d = await this.get('MEMBER#default', 'PROFILE'); return d ? budgetFrom(d) : undefined }
  async putDefaultBudget(b: Budget | undefined) {
    await this.put({ pk: 'MEMBER#default', sk: 'PROFILE', role: 'default', budgetMonthlyUsd: b ? b.monthlyUsd : null, ...(b ? { budgetAlertAt: b.alertAt, budgetHardStop: b.hardStop } : {}) })
  }
  async getIdentityDelivery(): Promise<Delivery | undefined> {
    const d = await this.get('IDENTITY', 'DELIVERY')
    if (!d || (d.state !== 'delivered' && d.state !== 'pending' && d.state !== 'notDelivered')) return undefined
    return { state: d.state, ...(typeof d.at === 'string' ? { at: d.at } : {}), ...(typeof d.errorCode === 'string' ? { errorCode: d.errorCode } : {}) }
  }
  async putIdentityDelivery(d: Delivery) { await this.put({ pk: 'IDENTITY', sk: 'DELIVERY', ...d }) }
  async getSettings() {
    const s = await this.get('SETTINGS', 'DEPLOYMENT')
    if (!s) return undefined
    return { defaultBaseline: s.defaultBaseline as DeploymentSettings['defaultBaseline'] }
  }
  async putSettings(s: Pick<DeploymentSettings, 'defaultBaseline'>) { await this.put({ pk: 'SETTINGS', sk: 'DEPLOYMENT', ...s }) }
}

/** A map attribute, or a JSON-string one (ingest may store pass-through fields either way). */
function jsonObj(v: unknown): Record<string, unknown> | undefined {
  let o = v
  if (typeof o === 'string') { try { o = JSON.parse(o) } catch { return undefined } }
  return typeof o === 'object' && o !== null && !Array.isArray(o) ? (o as Record<string, unknown>) : undefined
}

function prevMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number) as [number, number]
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`
}

function budgetFrom(o: Record<string, unknown>): Budget | undefined {
  if (typeof o.budgetMonthlyUsd !== 'number') return undefined // NULL or absent = no budget
  return { monthlyUsd: o.budgetMonthlyUsd, alertAt: typeof o.budgetAlertAt === 'number' ? o.budgetAlertAt : 0.8, hardStop: o.budgetHardStop === true }
}
export function memberFrom(k: string, o: Record<string, unknown>): MemberSettings {
  const budget = budgetFrom(o)
  return {
    key: k, group: (o.role === 'admin' || o.role === 'service' ? o.role : 'member') as MemberSettings['group'],
    ...(budget ? { budget } : {}), ...(o.cap && typeof o.cap === 'object' ? { cap: o.cap as MemberSettings['cap'] } : {}),
    ...(typeof o.name === 'string' ? { name: o.name } : {}), ...(typeof o.description === 'string' ? { description: o.description } : {}),
    ...(o.status === 'disabled' ? { disabled: true } : {}),
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : '', updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : '',
  }
}
/** Flat attributes (design §2.3a; 17's BudgetSource reads budgetMonthlyUsd / budgetHardStop). */
export function memberTo(m: MemberSettings): Record<string, unknown> {
  return {
    status: m.disabled ? 'disabled' : 'active', role: m.group, budgetMonthlyUsd: m.budget ? m.budget.monthlyUsd : null,
    ...(m.budget ? { budgetAlertAt: m.budget.alertAt, budgetHardStop: m.budget.hardStop } : {}), ...(m.cap ? { cap: m.cap } : {}),
    ...(m.name !== undefined ? { name: m.name } : {}), ...(m.description !== undefined ? { description: m.description } : {}),
    createdAt: m.createdAt, updatedAt: m.updatedAt,
  }
}

// ---------------------------------------------------------------- usage table (read only)

const RECORD_KEYS = new Set(['pk', 'sk', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'ttl', 'v'])
const ROLLUP_KEYS = new Set(['pk', 'sk', 'ttl', 'v'])
const MAX_PAGES = 10
const DAY_MS = 86_400_000

function recordOf(it: Item): StoredRecord {
  const o = fromItem(it)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (!RECORD_KEYS.has(k)) out[k] = v
  return out as StoredRecord
}

export class DynamoUsageStore implements UsageStore {
  private readonly db: Sender
  private readonly table: string
  private readonly retentionDays: number
  constructor(db: Sender, table: string, opts: { retentionDays?: number } = {}) { this.db = db; this.table = table; this.retentionDays = opts.retentionDays ?? 92 }

  /** Pages through a key range, applying the filter in code, until `limit` matches or MAX_PAGES. */
  private async scanRange(input: QueryCommandInput, q: RecordScan, scope: string, pkOk: (pk: string) => boolean, full: boolean): Promise<Page<StoredRecord>> {
    let { lek } = decodeCursor(scope, q.cursor, 'pk', pkOk)
    const items: StoredRecord[] = []
    for (let page = 0; page < MAX_PAGES && items.length < q.limit; page++) {
      const r = await this.db.send(new QueryCommand({ ...input, Limit: Math.max(q.limit - items.length, 10), ...(lek ? { ExclusiveStartKey: lek } : {}) }))
      const got = ((r.Items ?? []) as Item[])
      const rows = full ? got.map(recordOf) : await this.batchGet(got)
      for (const rec of rows) if (rec.ts >= q.from && rec.ts < q.to && (!q.filter || q.filter(rec))) items.push(rec)
      lek = r.LastEvaluatedKey as Item | undefined
      if (!lek) break
    }
    const next = encodeCursor(scope, lek)
    return { items: items.slice(0, q.limit), ...(next ? { nextCursor: next } : {}) }
  }

  /** Index rows (INCLUDE projections) → full records, in the index order. */
  private async batchGet(rows: Item[]): Promise<StoredRecord[]> {
    const keys = rows.map((r) => ({ pk: r.pk as AttributeValue, sk: r.sk as AttributeValue }))
    const found = new Map<string, StoredRecord>()
    for (let i = 0; i < keys.length; i += 100) {
      let pending: Item[] = keys.slice(i, i + 100) as Item[]
      for (let attempt = 0; pending.length && attempt < 5; attempt++) {
        const r = await this.db.send(new BatchGetItemCommand({ RequestItems: { [this.table]: { Keys: pending } } }))
        for (const it of (r.Responses?.[this.table] ?? []) as Item[]) found.set(`${it.pk?.S}|${it.sk?.S}`, recordOf(it))
        pending = (r.UnprocessedKeys?.[this.table]?.Keys ?? []) as Item[]
      }
    }
    return keys.flatMap((k) => { const r = found.get(`${k.pk.S}|${k.sk.S}`); return r ? [r] : [] })
  }

  async principalRecords(k: string, q: RecordScan) {
    return this.scanRange({
      TableName: this.table, KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b', ScanIndexForward: false,
      ExpressionAttributeValues: { ':p': { S: `P#${k}` }, ':a': { S: `T#${q.from}` }, ':b': { S: `T#${q.to}` } },
    }, q, `P#${k}`, (pk) => pk === `P#${k}`, true)
  }
  async allRecords(q: RecordScan): Promise<Page<StoredRecord>> {
    // gsi1 is one partition per UTC day: walk the days of [from, to) newest first; the cursor carries the day.
    const days: string[] = []
    for (let t = Date.parse(`${q.to.slice(0, 10)}T00:00:00Z`); t >= Date.parse(`${q.from.slice(0, 10)}T00:00:00Z`); t -= DAY_MS) days.push(new Date(t).toISOString().slice(0, 10))
    const c = decodeCursor('ALL', q.cursor, 'gsi1pk', (pk) => /^D#\d{4}-\d{2}-\d{2}$/.test(pk))
    let di = typeof c.extra.d === 'string' ? Math.max(0, days.indexOf(c.extra.d)) : 0
    let lek = c.lek
    const items: StoredRecord[] = []
    while (di < days.length && items.length < q.limit) {
      const r = await this.db.send(new QueryCommand({
        TableName: this.table, IndexName: 'gsi1', KeyConditionExpression: 'gsi1pk = :d', ScanIndexForward: false, Limit: Math.max(q.limit - items.length, 10),
        ExpressionAttributeValues: { ':d': { S: `D#${days[di]}` } }, ...(lek ? { ExclusiveStartKey: lek } : {}),
      }))
      for (const rec of await this.batchGet((r.Items ?? []) as Item[])) if (rec.ts >= q.from && rec.ts < q.to && (!q.filter || q.filter(rec))) items.push(rec)
      lek = r.LastEvaluatedKey as Item | undefined
      if (!lek) di += 1
    }
    const next = di < days.length ? encodeCursor('ALL', lek, { d: days[di] }) : undefined
    return { items: items.slice(0, q.limit), ...(next ? { nextCursor: next } : {}) }
  }
  async record(reqId: string, k?: string, ts?: string): Promise<StoredRecord | undefined> {
    if (k && ts) {
      const r = await this.db.send(new GetItemCommand({ TableName: this.table, Key: key(`P#${k}`, `T#${ts}#${reqId}`) }))
      return r.Item ? recordOf(r.Item as Item) : undefined
    }
    // No timestamp: a filtered read of the principal's partition, else of the day index over the retention window.
    if (k) {
      const items = await queryAll(this.db, {
        TableName: this.table, KeyConditionExpression: 'pk = :p', FilterExpression: 'reqId = :r',
        ExpressionAttributeValues: { ':p': { S: `P#${k}` }, ':r': { S: reqId } },
      }, 1)
      return items[0] ? recordOf(items[0]) : undefined
    }
    const now = Date.now()
    const from = ts ? Date.parse(ts) - DAY_MS : now - this.retentionDays * DAY_MS
    const to = ts ? Date.parse(ts) + DAY_MS : now + DAY_MS
    let cursor: string | undefined
    for (let i = 0; i < 400; i++) {
      const p = await this.allRecords({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit: 1, filter: (r) => r.reqId === reqId, ...(cursor ? { cursor } : {}) })
      if (p.items[0]) return p.items[0]
      if (!p.nextCursor) return undefined
      cursor = p.nextCursor
    }
    return undefined
  }
  async session(k: string, label: string, limit: number) {
    const rows = await queryAll(this.db, {
      TableName: this.table, IndexName: 'gsi2', KeyConditionExpression: 'gsi2pk = :s', ScanIndexForward: true,
      ExpressionAttributeValues: { ':s': { S: `S#${k}#${label}` } },
    }, limit)
    return this.batchGet(rows.slice(0, limit))
  }
  async rollups(from: string, to: string, k?: string): Promise<RollupItem[]> {
    const out: RollupItem[] = []
    for (let m = to.slice(0, 7); m >= from.slice(0, 7); m = prevMonth(m)) {
      const lo = m === from.slice(0, 7) ? from.slice(8, 10) : '01'
      const hi = m === to.slice(0, 7) ? to.slice(8, 10) : '31'
      const items = await queryAll(this.db, {
        TableName: this.table, KeyConditionExpression: 'pk = :p AND sk BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':p': { S: k ? `U#${k}#${m}` : `A#${m}` }, ':a': { S: `${lo}#` }, ':b': { S: `${hi}#~` } },
      })
      for (const it of items) {
        const o = fromItem(it)
        const parts = String(o.sk).split('#')
        const [dd, ...rest] = parts
        const principal = k ?? rest.shift() ?? 'none'
        const [dialect = '-', servedModel = '-', baseTier = '-'] = rest
        const counters: Record<string, number> = {}
        for (const [name, v] of Object.entries(o)) if (!ROLLUP_KEYS.has(name) && typeof v === 'number') counters[name] = v
        out.push({ day: `${m}-${dd}`, principal, dialect, servedModel, baseTier, counters })
      }
    }
    return out
  }
  async monthSpend(keys: readonly string[], month: string): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    for (let i = 0; i < keys.length; i += 100) {
      let pending: Item[] = keys.slice(i, i + 100).map((k) => key(`B#${k}#${month}`, 'TOTAL'))
      for (let attempt = 0; pending.length && attempt < 5; attempt++) {
        const r = await this.db.send(new BatchGetItemCommand({ RequestItems: { [this.table]: { Keys: pending } } }))
        for (const it of (r.Responses?.[this.table] ?? []) as Item[]) {
          const o = fromItem(it)
          const k = String(o.pk).slice(2, -(month.length + 1))
          // Budget spend = ΣA + ΣX (design §2.3a).
          out.set(k, (typeof o.spend === 'number' ? o.spend : 0) + (typeof o.asr === 'number' ? o.asr : 0))
        }
        pending = (r.UnprocessedKeys?.[this.table]?.Keys ?? []) as Item[]
      }
    }
    return out
  }
  async stateReports(): Promise<StateReport[]> {
    const items = await queryAll(this.db, { TableName: this.table, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': { S: 'C#state' } } }, 500)
    return items.map((it) => {
      const o = fromItem(it)
      const keys = jsonObj(o.identityKeys)
      return {
        ts: String(o.ts ?? ''), task: String(o.sk ?? ''), source: 'state', ...(typeof o.outcome === 'string' ? { outcome: o.outcome } : {}),
        ...(typeof o.configVersion === 'string' ? { configVersion: o.configVersion } : {}),
        ...(jsonObj(o.effective) ? { effective: jsonObj(o.effective) } : {}), ...(jsonObj(o.sources) ? { sources: jsonObj(o.sources) } : {}),
        ...(keys ? { identityKeys: { ...(typeof keys.configured === 'boolean' ? { configured: keys.configured } : {}), ...(typeof keys.loaded === 'boolean' ? { loaded: keys.loaded } : {}),
          ...(typeof keys.kids === 'number' ? { kids: keys.kids } : {}) } } : {}),
      }
    })
  }
  async configReports(limit: number): Promise<ConfigReport[]> {
    const r = await this.db.send(new QueryCommand({
      TableName: this.table, KeyConditionExpression: 'pk = :p', ScanIndexForward: false, Limit: limit, ExpressionAttributeValues: { ':p': { S: 'C#config' } },
    }))
    return ((r.Items ?? []) as Item[]).map((it) => {
      const o = fromItem(it)
      let drift: unknown = o.drift
      if (typeof drift === 'string') { try { drift = JSON.parse(drift) } catch { /* keep the string */ } }
      return {
        ts: String(o.ts ?? String(o.sk).split('#')[0]), task: String(o.task ?? String(o.sk).split('#')[1] ?? ''),
        ...(typeof o.source === 'string' ? { source: o.source } : {}), ...(typeof o.outcome === 'string' ? { outcome: o.outcome } : {}),
        ...(typeof o.status === 'string' ? { status: o.status } : {}), ...(typeof o.configVersion === 'string' ? { configVersion: o.configVersion } : {}),
        ...(typeof o.principalsVersion === 'string' ? { principalsVersion: o.principalsVersion } : {}),
        ...(Array.isArray(o.issues) ? { issues: o.issues as string[] } : {}), ...(Array.isArray(o.packs) ? { packs: o.packs as ConfigReport['packs'] } : {}),
        ...(jsonObj(o.effective) ? { effective: jsonObj(o.effective) } : {}), ...(jsonObj(o.sources) ? { sources: jsonObj(o.sources) } : {}),
        ...(drift !== undefined ? { drift } : {}),
      }
    })
  }
}
