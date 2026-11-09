// Adapters against a fake `send`: real SDK command objects are built and inspected; nothing leaves the process.
import { BatchGetItemCommand, GetItemCommand, PutItemCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'
import { fxAuto } from './__fixtures__/fx.ts'
import { configSortKey, DynamoBudgetSource, DynamoPolicySource, DynamoUsageStore, marshalItem, unmarshal, updateOf } from './dynamo.ts'
import { depsFromEnv } from './handler.ts'
import { S3BlocksStore } from './s3.ts'

class FakeSender {
  readonly sent: unknown[] = []
  private readonly reply: (cmd: unknown, n: number) => unknown
  constructor(reply: (cmd: unknown, n: number) => unknown) {
    this.reply = reply
  }
  async send(cmd: unknown): Promise<unknown> {
    this.sent.push(cmd)
    const r = this.reply(cmd, this.sent.length)
    if (r instanceof Error) throw r
    return r
  }
}
const err = (name: string, extra: Record<string, unknown> = {}): Error => Object.assign(new Error(name), { name, ...extra })

describe('DynamoDB adapters', () => {
  it('marshals plain values, drops undefined, round-trips', () => {
    const item = { pk: 'P#x', n: 1.5, b: true, z: null, l: [1, 'a', undefined], m: { a: undefined, c: 2 }, u: undefined }
    const m = marshalItem(item)
    expect(m).toEqual({ pk: { S: 'P#x' }, n: { N: '1.5' }, b: { BOOL: true }, z: { NULL: true }, l: { L: [{ N: '1' }, { S: 'a' }] }, m: { M: { c: { N: '2' } } } })
    expect(unmarshal({ M: m })).toEqual({ pk: 'P#x', n: 1.5, b: true, z: null, l: [1, 'a'], m: { c: 2 } })
    expect(() => marshalItem({ x: Number.NaN })).toThrow()
  })

  it('transact: conditional puts and ADD/SET updates in one TransactWriteItems', async () => {
    const ddb = new FakeSender(() => ({}))
    const store = new DynamoUsageStore(ddb, 'usage')
    const r = await store.transact([{ item: { pk: 'P#u', sk: 'T#1', a: 5 } }], [{ key: { pk: 'U#u#2026-11', sk: '08#x' }, add: { req: 1, spend: -3 }, ttl: 99, set: { servedTier: 'fast' } }])
    expect(r).toEqual({ ok: true })
    const cmd = ddb.sent[0] as TransactWriteItemsCommand
    expect(cmd).toBeInstanceOf(TransactWriteItemsCommand)
    const [put, upd] = cmd.input.TransactItems!
    expect(put!.Put).toMatchObject({ TableName: 'usage', ConditionExpression: 'attribute_not_exists(pk)', Item: { pk: { S: 'P#u' }, a: { N: '5' } } })
    expect(upd!.Update).toMatchObject({
      TableName: 'usage', Key: { pk: { S: 'U#u#2026-11' }, sk: { S: '08#x' } },
      UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :ttl), #s0 = :s0 ADD #c0 :c0, #c1 :c1',
      ExpressionAttributeNames: { '#ttl': 'ttl', '#c0': 'req', '#c1': 'spend', '#s0': 'servedTier' },
      ExpressionAttributeValues: { ':ttl': { N: '99' }, ':c0': { N: '1' }, ':c1': { N: '-3' }, ':s0': { S: 'fast' } },
    })
    expect(() => updateOf('t', { key: { pk: 'a', sk: 'b' }, add: { x: 0.5 }, ttl: 1 })).toThrow(/safe integer/)
  })

  it('putLatest: one conditional PutItem on ts; a failed condition is stale, anything else throws', async () => {
    const ddb = new FakeSender(() => ({}))
    const item = { pk: 'C#state', sk: 'task1', ts: '2026-11-08T06:05:00.000Z', identityKeys: { configured: true, loaded: true } }
    expect(await new DynamoUsageStore(ddb, 'usage').putLatest(item)).toBe('written')
    const cmd = ddb.sent[0] as PutItemCommand
    expect(cmd).toBeInstanceOf(PutItemCommand)
    expect(cmd.input).toEqual({ TableName: 'usage', Item: marshalItem(item), ConditionExpression: 'attribute_not_exists(#ts) OR #ts < :ts',
      ExpressionAttributeNames: { '#ts': 'ts' }, ExpressionAttributeValues: { ':ts': { S: '2026-11-08T06:05:00.000Z' } } })
    expect(await new DynamoUsageStore(new FakeSender(() => err('ConditionalCheckFailedException')), 'usage').putLatest(item)).toBe('stale')
    await expect(new DynamoUsageStore(new FakeSender(() => err('ThrottlingException')), 'usage').putLatest(item)).rejects.toThrow('ThrottlingException')
  })

  it('transact: maps cancellation reasons to duplicates and retryable conflicts', async () => {
    const puts = [{ item: { pk: 'P#a', sk: '1' } }, { item: { pk: 'P#b', sk: '2' } }]
    const dup = new DynamoUsageStore(new FakeSender(() => err('TransactionCanceledException', { CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }, { Code: 'None' }] })), 't')
    expect(await dup.transact(puts, [{ key: { pk: 'U', sk: 'x' }, add: { req: 1 }, ttl: 1 }])).toEqual({ ok: false, duplicates: [1], retryable: false })
    const conflict = new DynamoUsageStore(new FakeSender(() => err('TransactionCanceledException', { CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }] })), 't')
    expect(await conflict.transact(puts, [])).toEqual({ ok: false, duplicates: [], retryable: true })
    const throttled = new DynamoUsageStore(new FakeSender(() => err('ThrottlingException')), 't')
    expect(await throttled.transact(puts, [])).toEqual({ ok: false, duplicates: [], retryable: true })
    const denied = new DynamoUsageStore(new FakeSender(() => err('AccessDeniedException')), 't')
    await expect(denied.transact(puts, [])).rejects.toThrow('AccessDeniedException')
  })

  it('getCounters: BatchGetItem with unprocessed-key retries; numbers only, ttl dropped', async () => {
    const ddb = new FakeSender((cmd, n) => {
      expect(cmd).toBeInstanceOf(BatchGetItemCommand)
      return n === 1
        ? { Responses: { usage: [{ pk: { S: 'B#u#2026-11' }, sk: { S: 'TOTAL' }, spend: { N: '10' }, ttl: { N: '5' } }] },
            UnprocessedKeys: { usage: { Keys: [{ pk: { S: 'B#v#2026-11' }, sk: { S: 'TOTAL' } }] } } }
        : { Responses: { usage: [{ pk: { S: 'B#v#2026-11' }, sk: { S: 'TOTAL' }, spend: { N: '7' }, asr: { N: '1' } }] } }
    })
    const out = await new DynamoUsageStore(ddb, 'usage').getCounters([{ pk: 'B#u#2026-11', sk: 'TOTAL' }, { pk: 'B#v#2026-11', sk: 'TOTAL' }])
    expect(Object.fromEntries(out)).toEqual({ 'B#u#2026-11|TOTAL': { spend: 10 }, 'B#v#2026-11|TOTAL': { spend: 7, asr: 1 } })
  })

  it('policy source: CONFIG v#<n>, document version must match, policy version must match; cached', async () => {
    const doc = { schemaVersion: 1, version: '7-2026-11-08T05:00:00Z', policy: { ...fxAuto }, assessor: { mode: 'observe', threshold: 0.7 } }
    const ddb = new FakeSender((cmd) => {
      expect(cmd).toBeInstanceOf(GetItemCommand)
      const key = (cmd as GetItemCommand).input.Key!
      return key.sk?.S === 'v#7' ? { Item: { doc: { S: JSON.stringify(doc) } } } : {}
    })
    const src = new DynamoPolicySource(ddb, 'console')
    const got = await src.get('7-2026-11-08T05:00:00Z', 'fx-auto-1')
    expect([got?.policy.version, got?.assessorThreshold]).toEqual(['fx-auto-1', 0.7])
    expect(await src.get('7-2026-11-08T05:00:00Z', 'other')).toBeUndefined()
    expect(await src.get('7-tampered', 'fx-auto-1')).toBeUndefined()     // same n, different version string
    expect(await src.get(undefined, 'fx-auto-1')).toBeUndefined()        // pre-C3 line
    expect(await src.get('8-x', 'fx-auto-1')).toBeUndefined()
    const before = ddb.sent.length
    await src.get('7-2026-11-08T05:00:00Z', 'fx-auto-1')
    expect(ddb.sent.length).toBe(before) // cached
  })

  it('config sort keys: <n>-<suffix> → v#<n>; 0-baked.<sha8> → v#0#<sha8>; legacy 0-baked → v#0', () => {
    expect(configSortKey('7-20261108T055900Z')).toBe('v#7')
    expect(configSortKey('0-baked.ab12cd34')).toBe('v#0#ab12cd34')
    expect(configSortKey('0-baked')).toBe('v#0')
    expect(configSortKey('0-baked.AB12CD34')).toBe('v#0')     // not a sha8: legacy key, then the doc.version check refuses it
    expect(configSortKey('x-1')).toBeUndefined()
  })

  it('policy source: the baked document of a deploy (0-baked.<sha8>) and the legacy 0-baked', async () => {
    const docs: Record<string, { version: string }> = {
      'v#0#ab12cd34': { version: '0-baked.ab12cd34' }, 'v#0': { version: '0-baked' },
    }
    const ddb = new FakeSender((cmd) => {
      const sk = (cmd as GetItemCommand).input.Key!.sk!.S!
      const d = docs[sk]
      return d ? { Item: { doc: { S: JSON.stringify({ schemaVersion: 1, ...d, policy: { ...fxAuto }, assessor: { mode: 'off' } }) } } } : {}
    })
    const src = new DynamoPolicySource(ddb, 'console')
    expect((await src.get('0-baked.ab12cd34', 'fx-auto-1'))?.policy.version).toBe('fx-auto-1')
    expect((await src.get('0-baked', 'fx-auto-1'))?.policy.version).toBe('fx-auto-1')
    expect(await src.get('0-baked.ffffffff', 'fx-auto-1')).toBeUndefined()   // another deploy's baked content: not seeded
    expect((ddb.sent as GetItemCommand[]).map((c) => c.input.Key!.sk!.S)).toEqual(['v#0#ab12cd34', 'v#0', 'v#0#ffffffff'])
  })

  it('budget source: MEMBER#<p> and MEMBER#default PROFILE items', async () => {
    const ddb = new FakeSender(() => ({ Responses: { console: [
      { pk: { S: 'MEMBER#user:a' }, budgetMonthlyUsd: { N: '5' }, budgetHardStop: { BOOL: true } },
      { pk: { S: 'MEMBER#user:b' }, budgetMonthlyUsd: { NULL: true } },
      { pk: { S: 'MEMBER#default' }, budgetMonthlyUsd: { N: '1' }, budgetHardStop: { BOOL: false } },
    ] } }))
    const r = await new DynamoBudgetSource(ddb, 'console').get(['user:a', 'user:b'])
    expect(Object.fromEntries(r.members)).toEqual({ 'user:a': { monthlyUsd: 5, hardStop: true }, 'user:b': { monthlyUsd: null } })
    expect(r.fallback).toEqual({ monthlyUsd: 1, hardStop: false })
    const keys = ((ddb.sent[0] as BatchGetItemCommand).input.RequestItems!.console!.Keys ?? []).map((k) => k.pk?.S)
    expect(keys).toEqual(['MEMBER#user:a', 'MEMBER#user:b', 'MEMBER#default'])
  })
})

describe('S3 budget-blocks store', () => {
  it('read: missing object → undefined; present → doc + etag', async () => {
    const missing = new S3BlocksStore(new FakeSender(() => err('NoSuchKey', { $metadata: { httpStatusCode: 404 } })), 'cfg')
    expect(await missing.read()).toBeUndefined()
    const doc = { schemaVersion: 1, generatedAt: 'x', principals: [] }
    const present = new S3BlocksStore(new FakeSender((cmd) => {
      expect(cmd).toBeInstanceOf(GetObjectCommand)
      expect((cmd as GetObjectCommand).input).toEqual({ Bucket: 'cfg', Key: 'identity/budget-blocks.json' })
      return { Body: { transformToString: async () => JSON.stringify(doc) }, ETag: '"e1"' }
    }), 'cfg')
    expect(await present.read()).toEqual({ doc, etag: '"e1"' })
  })

  it('write: If-Match with an etag, If-None-Match * without; 412 → conflict', async () => {
    const s3 = new FakeSender(() => ({}))
    const store = new S3BlocksStore(s3, 'cfg')
    const doc = { schemaVersion: 1 as const, generatedAt: 'x', principals: [] }
    expect(await store.write(doc, '"e1"')).toBe('ok')
    expect(await store.write(doc, undefined)).toBe('ok')
    const [a, b] = s3.sent as PutObjectCommand[]
    expect(a!.input).toMatchObject({ Bucket: 'cfg', Key: 'identity/budget-blocks.json', IfMatch: '"e1"', ContentType: 'application/json' })
    expect(b!.input).toMatchObject({ IfNoneMatch: '*' })
    expect(b!.input.IfMatch).toBeUndefined()
    const pre = new S3BlocksStore(new FakeSender(() => err('PreconditionFailed', { $metadata: { httpStatusCode: 412 } })), 'cfg')
    expect(await pre.write(doc, '"e0"')).toBe('conflict')
  })
})

describe('handler environment', () => {
  const clients = { ddb: new FakeSender(() => ({})), s3: new FakeSender(() => ({})) } as never
  it('fails fast on a missing table or a bad retention', () => {
    expect(() => depsFromEnv({ CONSOLE_TABLE: 'c', CATALOG_REGION: 'ap-northeast-1' }, clients)).toThrow(/USAGE_TABLE/)
    expect(() => depsFromEnv({ USAGE_TABLE: 'u', CONSOLE_TABLE: 'c', CATALOG_REGION: 'ap-northeast-1', RECORD_RETENTION_DAYS: '0' }, clients)).toThrow(/RETENTION/)
    expect(() => depsFromEnv({ USAGE_TABLE: 'u', CONSOLE_TABLE: 'c', CATALOG_REGION: 'ap-northeast-1', BUDGETS: 'on' }, clients)).toThrow(/CONFIG_BUCKET/)
    expect(() => depsFromEnv({ USAGE_TABLE: 'u', CONSOLE_TABLE: 'c', CATALOG_REGION: 'nowhere-1' }, clients)).toThrow(/catalog/)
  })
  it('builds deps; budgets only when enabled', () => {
    const d = depsFromEnv({ USAGE_TABLE: 'u', CONSOLE_TABLE: 'c', CATALOG_REGION: 'ap-northeast-1' }, clients)
    expect([d.retentionDays, d.budgets, d.catalog.region]).toEqual([90, undefined, 'ap-northeast-1'])
    const b = depsFromEnv({ USAGE_TABLE: 'u', CONSOLE_TABLE: 'c', CONFIG_BUCKET: 'b', AWS_REGION: 'ap-northeast-1', BUDGETS: 'on', RECORD_RETENTION_DAYS: '30' }, clients)
    expect([b.retentionDays, !!b.budgets]).toEqual([30, true])
  })
})
