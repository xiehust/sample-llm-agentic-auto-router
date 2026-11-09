// AWS adapters against a fake `send` (no AWS calls): storage layout per design §2.3a, cursor scope, conditional
// activation, Cognito rotation and guards, the first-admin seed, the Lambda environment contract.
import { describe, expect, it } from 'vitest'
import { decodeCursor, DynamoConsoleStore, DynamoUsageStore, encodeCursor, fromItem, toItem, type Sender } from './aws/dynamo.ts'
import { AgentCoreGateway, CognitoClientDirectory, CognitoDirectory, EcsRouterTasks, S3ObjectStore } from './aws/services.ts'
import { depsFromEnv, EnvError, type AwsClients } from './lambda.ts'
import { seedAdmin } from './seed.ts'
import { baseDocument } from './test-fixtures.ts'

type Call = { op: string; input: any }
function fake(reply: (op: string, input: any) => unknown): Sender & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    async send(cmd: any) {
      const op = String(cmd.constructor.name).replace(/Command$/, '')
      calls.push({ op, input: cmd.input })
      const r = reply(op, cmd.input)
      if (r instanceof Error) throw r
      return r ?? {}
    },
  }
}
const err = (name: string) => Object.assign(new Error(name), { name })

describe('marshalling and cursors', () => {
  it('round-trips plain JSON (NULL, nested maps and lists); undefined is dropped', () => {
    const o = { s: 'x', n: 1.5, b: true, z: null, l: [1, 'a', { k: false }], m: { a: { b: [null] } }, u: undefined }
    expect(fromItem(toItem(o))).toEqual({ s: 'x', n: 1.5, b: true, z: null, l: [1, 'a', { k: false }], m: { a: { b: [null] } } })
    expect(() => toItem({ x: Number.NaN })).toThrow()
  })
  it('a cursor is bound to its scope and partition; another principal’s (also a prefix-sharing one) is a 400', () => {
    const c = encodeCursor('P#user:abc', toItem({ pk: 'P#user:abc', sk: 'T#2026' }))!
    expect(decodeCursor('P#user:abc', c, 'pk', (pk) => pk === 'P#user:abc').lek).toBeDefined()
    expect(() => decodeCursor('P#user:abcd', c, 'pk', (pk) => pk === 'P#user:abcd')).toThrow(/cursor/)
    const forged = Buffer.from(JSON.stringify({ s: 'P#user:abcd', k: { pk: 'P#user:abc', sk: 'T#1' } })).toString('base64url')
    expect(() => decodeCursor('P#user:abcd', forged, 'pk', (pk) => pk === 'P#user:abcd')).toThrow(/cursor/)
    expect(() => decodeCursor('x', 'not-json', 'pk', () => true)).toThrow(/cursor/)
    const plus = encodeCursor('P#client:ab+cd', toItem({ pk: 'P#client:ab+cd', sk: 'T#1' }))!
    expect(decodeCursor('P#client:ab+cd', plus, 'pk', (pk) => pk === 'P#client:ab+cd').lek).toBeDefined()
    // The key checked is the one of the index the query uses: a day-index cursor is no base-table cursor.
    const day = encodeCursor('P#user:abc', toItem({ pk: 'P#user:abc', sk: 'T#1', gsi1pk: 'D#2026-11-08', gsi1sk: 'x' }))!
    expect(() => decodeCursor('P#user:abc', day, 'pk', (pk) => pk === 'P#user:abc')).toThrow(/cursor/)
    const idx = encodeCursor('ALL', toItem({ pk: 'P#user:abc', sk: 'T#1', gsi1pk: 'D#2026-11-08', gsi1sk: 'x' }))!
    expect(decodeCursor('ALL', idx, 'gsi1pk', (pk) => pk.startsWith('D#')).lek).toBeDefined()
    expect(() => decodeCursor('ALL', idx, 'gsi1pk', (pk) => pk === 'D#2026-11-07')).toThrow(/cursor/)
  })
})

describe('DynamoConsoleStore (design §2.3a)', () => {
  it('ACTIVE {version}: the seeded baked version counts as delivered; versions ordered by n, not by string', async () => {
    const db = fake((op, i) => {
      if (op === 'GetItem' && i.Key.sk.S === 'ACTIVE') return { Item: toItem({ pk: 'CONFIG', sk: 'ACTIVE', version: '0-baked' }) }
      if (op === 'Query') return { Items: [9, 10, 2].map((n) => toItem({ sk: `v#${n}`, version: `${n}-x`, author: 'a', createdAt: 't', comment: 'c', changed: [] })) }
      return {}
    })
    const s = new DynamoConsoleStore(db, 'console')
    expect(await s.getActive()).toEqual({ n: 0, version: '0-baked', delivered: true })
    expect((await s.listVersionMetas(10)).map((m) => m.n)).toEqual([10, 9, 2])
    expect(await s.latestVersion()).toBe(10)
    expect(db.calls.find((c) => c.op === 'Query')?.input.ProjectionExpression).not.toMatch(/doc/)
  })
  it('activate: one transaction (version put if absent + ACTIVE put on the expected version); cancelled = conflict', async () => {
    let fail = false
    const db = fake((op) => (op === 'TransactWriteItems' && fail ? err('TransactionCanceledException') : {}))
    const s = new DynamoConsoleStore(db, 'console')
    const v = { meta: { version: '1-20261108T120000Z', n: 1, author: 'user:x', createdAt: 't', comment: 'c', changed: ['identity'] }, document: baseDocument() }
    expect(await s.activate(v, '0-baked')).toBe('ok')
    const tx = db.calls[0]!.input.TransactItems
    expect(tx[0].Put).toMatchObject({ ConditionExpression: 'attribute_not_exists(pk)', Item: { pk: { S: 'CONFIG' }, sk: { S: 'v#1' }, doc: { S: JSON.stringify(baseDocument()) } } })
    expect(tx[1].Put).toMatchObject({ ConditionExpression: '#v = :expect', ExpressionAttributeValues: { ':expect': { S: '0-baked' } }, Item: { sk: { S: 'ACTIVE' }, version: { S: v.meta.version }, delivered: { BOOL: false } } })
    fail = true
    expect(await s.activate(v, '0-baked')).toBe('conflict')
  })
  it('MEMBER#<key>/PROFILE flat attributes; NULL budget = none; MEMBER#default; list skips the default', async () => {
    const items = new Map<string, any>()
    const db = fake((op, i) => {
      if (op === 'PutItem') { items.set(`${i.Item.pk.S}|${i.Item.sk.S}`, i.Item); return {} }
      if (op === 'GetItem') return { Item: items.get(`${i.Key.pk.S}|${i.Key.sk.S}`) }
      if (op === 'Scan') return { Items: [...items.values()].filter((x) => x.pk.S.startsWith('MEMBER#') && x.pk.S !== 'MEMBER#default') }
      return {}
    })
    const s = new DynamoConsoleStore(db, 'console')
    await s.putMember({ key: 'user:abc', group: 'admin', budget: { monthlyUsd: 50, alertAt: 0.8, hardStop: true }, cap: { maxTier: 'fast' }, createdAt: 'c', updatedAt: 'u' })
    expect(fromItem(items.get('MEMBER#user:abc|PROFILE'))).toEqual({
      pk: 'MEMBER#user:abc', sk: 'PROFILE', status: 'active', role: 'admin', budgetMonthlyUsd: 50, budgetAlertAt: 0.8, budgetHardStop: true, cap: { maxTier: 'fast' }, createdAt: 'c', updatedAt: 'u',
    })
    await s.putMember({ key: 'client:svc1', group: 'service', name: 'ci', disabled: true, createdAt: 'c', updatedAt: 'u' })
    expect(fromItem(items.get('MEMBER#client:svc1|PROFILE'))).toMatchObject({ status: 'disabled', role: 'service', budgetMonthlyUsd: null })
    expect(await s.getMember('client:svc1')).toEqual({ key: 'client:svc1', group: 'service', name: 'ci', disabled: true, createdAt: 'c', updatedAt: 'u' })
    await s.putDefaultBudget({ monthlyUsd: 10, alertAt: 0.5, hardStop: false })
    expect(await s.getDefaultBudget()).toEqual({ monthlyUsd: 10, alertAt: 0.5, hardStop: false })
    await s.putDefaultBudget(undefined)
    expect(await s.getDefaultBudget()).toBeUndefined()
    expect((await s.listMembers()).map((m) => m.key).sort()).toEqual(['client:svc1', 'user:abc'])
  })
})

describe('baked configuration storage (0d-effective-config §4.2)', () => {
  it('seed v#0#<sha8> is a conditional put (already seeded = no-op); first activation needs no ACTIVE item; metas skip seeds', async () => {
    let seeded = false
    const db = fake((op, i) => {
      if (op === 'PutItem' && i.Item.sk.S === 'v#0#0123abcd') { if (seeded) return err('ConditionalCheckFailedException'); seeded = true; return {} }
      if (op === 'Query') return { Items: [toItem({ sk: 'v#0#0123abcd', version: '0-baked.0123abcd' }), toItem({ sk: 'v#1', version: '1-x' })] }
      return {}
    })
    const s = new DynamoConsoleStore(db, 'console')
    const v = { meta: { version: '0-baked.0123abcd', n: 0, author: 'cdk', createdAt: '', comment: '', changed: [] }, document: baseDocument() }
    await s.seedBakedVersion('0123abcd', v)
    await s.seedBakedVersion('0123abcd', v)
    expect(db.calls.filter((c) => c.op === 'PutItem').map((c) => c.input.ConditionExpression)).toEqual(['attribute_not_exists(pk)', 'attribute_not_exists(pk)'])
    expect((await s.listVersionMetas(10)).map((m) => m.n)).toEqual([1])
    await s.activate({ ...v, meta: { ...v.meta, version: '1-x', n: 1 } }, undefined)
    expect(db.calls.at(-1)!.input.TransactItems[1].Put.ConditionExpression).toBe('attribute_not_exists(pk)')
  })
  it('S3 getObject: ETag returned; If-None-Match → not-modified on 304; absent → undefined', async () => {
    const s3 = fake((op, i) => {
      if (i.Key === 'missing') return err('NoSuchKey')
      if (i.IfNoneMatch === '"e1"') return Object.assign(err('NotModified'), { $metadata: { httpStatusCode: 304 } })
      return { Body: { transformToString: async () => '{"a":1}' }, ETag: '"e1"' }
    })
    const store = new S3ObjectStore(s3, 'bucket')
    expect(await store.getObject('config/baked.json')).toEqual({ body: '{"a":1}', etag: '"e1"' })
    expect(await store.getObject('config/baked.json', '"e1"')).toBe('not-modified')
    expect(await store.getObject('missing')).toBeUndefined()
  })
})

describe('router state lines and running tasks (0d-effective-config §7)', () => {
  it('stateReports: C#state items, sk = task, identityKeys and effective read (maps or JSON strings)', async () => {
    const db = fake(() => ({ Items: [
      toItem({ pk: 'C#state', sk: 't1', ts: '2026-11-08T11:55:00.000Z', source: 'state', outcome: 'active', configVersion: '1-x', identityKeys: { configured: true, loaded: true, kids: 2 }, effective: '{"identityMode":"observe"}' }),
    ] }))
    expect(await new DynamoUsageStore(db, 'usage').stateReports()).toEqual([{ ts: '2026-11-08T11:55:00.000Z', task: 't1', source: 'state', outcome: 'active', configVersion: '1-x',
      effective: { identityMode: 'observe' }, identityKeys: { configured: true, loaded: true, kids: 2 } }])
    expect(db.calls[0]!.input.ExpressionAttributeValues[':p'].S).toBe('C#state')
  })
  it('EcsRouterTasks: runningCount from DescribeServices; undefined on error', async () => {
    expect(await new EcsRouterTasks(fake(() => ({ services: [{ runningCount: 2 }] })), 'c', 's').runningCount()).toBe(2)
    expect(await new EcsRouterTasks(fake(() => err('AccessDeniedException')), 'c', 's').runningCount()).toBeUndefined()
  })
})

describe('DynamoUsageStore (17 layout)', () => {
  it('rollups: U#<principal>#<month> and A#<month> sort keys parsed into rows with counters', async () => {
    const db = fake((op, i) => {
      if (i.ExpressionAttributeValues[':p'].S === 'U#user:a#2026-11') return { Items: [toItem({ pk: 'U#user:a#2026-11', sk: '08#openai-responses#m1#standard', req: 2, spend: 5, ttl: 1 })] }
      if (i.ExpressionAttributeValues[':p'].S === 'A#2026-11') return { Items: [toItem({ pk: 'A#2026-11', sk: '07#none#openai-chat#m2#-', req: 1 })] }
      return { Items: [] }
    })
    const s = new DynamoUsageStore(db, 'usage')
    expect(await s.rollups('2026-11-01', '2026-11-08', 'user:a')).toEqual([{ day: '2026-11-08', principal: 'user:a', dialect: 'openai-responses', servedModel: 'm1', baseTier: 'standard', counters: { req: 2, spend: 5 } }])
    expect(await s.rollups('2026-11-01', '2026-11-08')).toEqual([{ day: '2026-11-07', principal: 'none', dialect: 'openai-chat', servedModel: 'm2', baseTier: '-', counters: { req: 1 } }])
    expect(db.calls[0]!.input.ExpressionAttributeValues[':a'].S).toBe('01#')
  })
  it('month spend = ΣA + ΣX from B#<principal>#<month>/TOTAL', async () => {
    const db = fake(() => ({ Responses: { usage: [toItem({ pk: 'B#user:a#2026-11', sk: 'TOTAL', spend: 100, asr: 7 })] } }))
    expect(await new DynamoUsageStore(db, 'usage').monthSpend(['user:a', 'user:b'], '2026-11')).toEqual(new Map([['user:a', 107]]))
  })
  it('principal records: key range on P#, cursor round trip in scope; record by ts is one GetItem', async () => {
    const rec = (n: number) => toItem({ pk: 'P#user:a', sk: `T#2026-11-08T0${n}:00:00.000Z#r${n}`, ts: `2026-11-08T0${n}:00:00.000Z`, reqId: `r${n}`, principal: 'user:a', gsi1pk: 'D#2026-11-08', ttl: 1 })
    const db = fake((op, i) => {
      if (op === 'GetItem') return { Item: rec(1) }
      return i.ExclusiveStartKey ? { Items: [rec(1)] } : { Items: [rec(2)], LastEvaluatedKey: toItem({ pk: 'P#user:a', sk: 'T#x' }) }
    })
    const s = new DynamoUsageStore(db, 'usage')
    const q = { from: '2026-11-08T00:00:00.000Z', to: '2026-11-09T00:00:00.000Z', limit: 1 }
    const p1 = await s.principalRecords('user:a', q)
    expect(p1.items.map((r) => r.reqId)).toEqual(['r2'])
    expect(p1.items[0]).not.toHaveProperty('gsi1pk')
    const p2 = await s.principalRecords('user:a', { ...q, cursor: p1.nextCursor! })
    expect(p2.items.map((r) => r.reqId)).toEqual(['r1'])
    await expect(s.principalRecords('user:b', { ...q, cursor: p1.nextCursor! })).rejects.toThrow(/cursor/)
    await s.record('r1', 'user:a', '2026-11-08T01:00:00.000Z')
    expect(db.calls.at(-1)).toMatchObject({ op: 'GetItem', input: { Key: { pk: { S: 'P#user:a' }, sk: { S: 'T#2026-11-08T01:00:00.000Z#r1' } } } })
  })
  it('config reports: C#config newest first; drift JSON parsed; outcome/source kept', async () => {
    const db = fake(() => ({ Items: [toItem({ pk: 'C#config', sk: '2026-11-08T01:00:00.000Z#t1', ts: '2026-11-08T01:00:00.000Z', task: 't1', source: 'config', outcome: 'applied', configVersion: '1-x', drift: '{"pack":"v2.2"}' })] }))
    expect(await new DynamoUsageStore(db, 'usage').configReports(5)).toEqual([{ ts: '2026-11-08T01:00:00.000Z', task: 't1', source: 'config', outcome: 'applied', configVersion: '1-x', drift: { pack: 'v2.2' } }])
  })
})

describe('Cognito adapters', () => {
  it('rotateSecret: list, add, then delete every older secret; reserved clients are refused', async () => {
    const idp = fake((op) => {
      if (op === 'ListUserPoolClientSecrets') return { ClientSecrets: [{ ClientSecretId: 'old1' }, { ClientSecretId: 'old2' }] }
      if (op === 'AddUserPoolClientSecret') return { ClientSecretDescriptor: { ClientSecretId: 'new', ClientSecretValue: 'sekret' } }
      return {}
    })
    const c = new CognitoClientDirectory(idp, { userPoolId: 'p', prefix: 'llmar', invokeScope: 'llmar/invoke', reserved: ['cliclient'] })
    expect(await c.rotateSecret('svc1')).toEqual({ secret: 'sekret' })
    expect(idp.calls.map((x) => `${x.op}:${x.input.ClientSecretId ?? ''}`)).toEqual(['ListUserPoolClientSecrets:', 'AddUserPoolClientSecret:', 'DeleteUserPoolClientSecret:old1', 'DeleteUserPoolClientSecret:old2'])
    await expect(c.rotateSecret('cliclient')).rejects.toThrow(/reserved/)
    await expect(c.deleteClient('cliclient')).rejects.toThrow(/reserved/)
  })
  it('createClient: the fixed service-client shape (0d): only the name comes from the admin', async () => {
    const idp = fake(() => ({ UserPoolClient: { ClientId: 'id1', ClientSecret: 's1' } }))
    const c = new CognitoClientDirectory(idp, { userPoolId: 'p', prefix: 'llmar', invokeScope: 'llmar/invoke', reserved: [] })
    await c.createClient('ci runner')
    expect(idp.calls[0]).toEqual({ op: 'CreateUserPoolClient', input: {
      UserPoolId: 'p', ClientName: 'llmar-svc-ci-runner', GenerateSecret: true, AllowedOAuthFlows: ['client_credentials'], AllowedOAuthFlowsUserPoolClient: true,
      AllowedOAuthScopes: ['llmar/invoke'], SupportedIdentityProviders: ['COGNITO'], ExplicitAuthFlows: [], CallbackURLs: [], LogoutURLs: [],
    } })
    await c.createClient('x"; AllowedOAuthScopes=aws.cognito.signin.user.admin')
    expect(idp.calls[1]!.input).toMatchObject({ ClientName: 'llmar-svc-x-AllowedOAuthScopes-aws.cognito.signin.user.admin', AllowedOAuthScopes: ['llmar/invoke'] })
    // Rotation never updates the client (no UpdateUserPoolClient call), so the settings stay.
    const rot = fake((op) => (op === 'AddUserPoolClientSecret' ? { ClientSecretDescriptor: { ClientSecretId: 'n', ClientSecretValue: 'v' } } : { ClientSecrets: [] }))
    await new CognitoClientDirectory(rot, { userPoolId: 'p', prefix: 'llmar', invokeScope: 'llmar/invoke', reserved: [] }).rotateSecret('id1')
    expect(rot.calls.map((x) => x.op)).not.toContain('UpdateUserPoolClient')
  })
  it('createUser: an existing e-mail is "exists"; userBySub refuses filter injection', async () => {
    const idp = fake((op) => (op === 'AdminCreateUser' ? err('UsernameExistsException') : {}))
    const d = new CognitoDirectory(idp, 'p')
    expect(await d.createUser({ email: 'a@b.cd', name: 'A', role: 'member' })).toBe('exists')
    await expect(d.userBySub('x" or email = "y')).rejects.toThrow()
  })
})

describe('gateway', () => {
  it('maps authorizer, targets, rules, fallback chain and forwarded headers (read only)', async () => {
    const ctl = fake((op) => {
      if (op === 'GetGateway') return { gatewayId: 'gw-1', gatewayUrl: 'https://gw', status: 'READY', authorizerConfiguration: { customJWTAuthorizer: { discoveryUrl: 'https://idp/.well-known', allowedScopes: ['llmar/invoke'] } } }
      if (op === 'ListGatewayTargets') return { items: [{ targetId: 't1', name: 'router' }, { targetId: 't2', name: 'bedrock' }] }
      if (op === 'GetGatewayTarget') return { status: 'READY', targetConfiguration: { http: { allowedRequestHeaders: ['X-Api-Key', 'anthropic-beta'] } } }
      if (op === 'ListGatewayRules') return { gatewayRules: [{ priority: 900, conditions: [], actions: [{ routeToTarget: { staticRoute: { targetName: 'router', fallback: { targetFallback: [{ targetName: 'bedrock', model: 'm' }] } } } }] }] }
      return {}
    })
    const g = await new AgentCoreGateway(ctl, 'gw-1').describe()
    expect(g).toMatchObject({ id: 'gw-1', url: 'https://gw', authorizer: { allowedScopes: ['llmar/invoke'] }, fallbackChain: ['bedrock (m)'], forwardedHeaders: ['anthropic-beta', 'x-api-key'],
      rules: [{ priority: 900, target: 'router' }] })
    expect(g.targets).toEqual([{ name: 'router', role: 'router', detail: 'READY' }, { name: 'bedrock', role: 'fallback', detail: 'READY' }])
    expect(ctl.calls.every((c) => /^(Get|List)/.test(c.op))).toBe(true)
  })
})

describe('seed-admin custom resource', () => {
  const props = { email: 'Boss@Example.com', group: 'admin' }
  it('invites a new user, adds it to admin, writes the MEMBER item if absent; never logs the e-mail', async () => {
    const logs: unknown[] = []
    const idp = fake((op) => (op === 'ListUsers' ? { Users: [] } : op === 'AdminCreateUser' ? { User: { Username: 'boss@example.com', Attributes: [{ Name: 'sub', Value: 'ABC-1' }] } } : {}))
    const db = fake(() => ({}))
    const r = await seedAdmin({ RequestType: 'Create', ResourceProperties: props }, { idp, db, userPoolId: 'p', table: 'console', now: () => 0, log: (x) => logs.push(x) })
    expect(r).toEqual({ PhysicalResourceId: 'seed-admin', Data: { sub: 'abc-1' } })
    expect(idp.calls.map((c) => c.op)).toEqual(['ListUsers', 'AdminCreateUser', 'AdminAddUserToGroup'])
    expect(db.calls[0]!.input).toMatchObject({ ConditionExpression: 'attribute_not_exists(pk)', Item: { pk: { S: 'MEMBER#user:abc-1' }, sk: { S: 'PROFILE' }, status: { S: 'active' }, role: { S: 'admin' } } })
    expect(JSON.stringify(logs)).not.toMatch(/example\.com/i)
  })
  it('an existing user is reused and an existing member is not overwritten; Delete is a no-op', async () => {
    const idp = fake((op) => (op === 'ListUsers' ? { Users: [{ Username: 'u1', Attributes: [{ Name: 'sub', Value: 's1' }] }] } : {}))
    const db = fake(() => err('ConditionalCheckFailedException'))
    expect(await seedAdmin({ RequestType: 'Update', ResourceProperties: props }, { idp, db, userPoolId: 'p', table: 't', log: () => {} })).toEqual({ PhysicalResourceId: 'seed-admin', Data: { sub: 's1' } })
    expect(idp.calls.map((c) => c.op)).toEqual(['ListUsers', 'AdminAddUserToGroup'])
    const none = fake(() => ({}))
    expect(await seedAdmin({ RequestType: 'Delete', PhysicalResourceId: 'seed-admin' }, { idp: none, db: none, userPoolId: 'p', table: 't' })).toEqual({ PhysicalResourceId: 'seed-admin' })
    expect(none.calls).toEqual([])
    await expect(seedAdmin({ RequestType: 'Create', ResourceProperties: { email: 'x" or "1' } }, { idp, db, userPoolId: 'p', table: 't' })).rejects.toThrow(/e-mail/)
  })
})

describe('depsFromEnv (a3 ConsoleStack env contract)', () => {
  const clients: AwsClients = { dynamodb: fake(() => ({})), s3: fake(() => ({})), cognito: fake(() => ({})), agentcore: fake(() => ({})), cloudwatch: fake(() => ({})), ecs: fake(() => ({})) }
  const env = {
    CONSOLE_TABLE: 'c', USAGE_TABLE: 'u', CONFIG_BUCKET: 'b', USER_POOL_ID: 'p', PREFIX: 'llmar', CONSOLE_SCOPE: 'llmar/console', INVOKE_SCOPE: 'llmar/invoke',
    GATEWAY_ID: 'gw', MODEL_UNIVERSE: 'a, b', ROUTER_CLUSTER: 'cl', ROUTER_SERVICE: 'sv', CLI_CLIENT_ID: 'cli', AWS_REGION: 'ap-northeast-1',
    COGNITO_DOMAIN: 'https://auth.example.com/', CALLBACK_PORTS: '53682,53683', IDENTITY_HEADER: '',
  }
  it('builds the deps; endpoints derive from COGNITO_DOMAIN; an empty IDENTITY_HEADER means none', () => {
    const d = depsFromEnv(env, clients)
    expect(d.env).toMatchObject({ prefix: 'llmar', region: 'ap-northeast-1', cognitoDomain: 'https://auth.example.com', tokenEndpoint: 'https://auth.example.com/oauth2/token',
      revokeEndpoint: 'https://auth.example.com/oauth2/revoke', callbackPorts: [53682, 53683], identityHeader: null, refreshDays: 30, modelUniverse: ['a', 'b'] })
    expect(d.catalog.region).toBe('ap-northeast-1')
  })
  it('fails fast on missing or invalid keys', () => {
    expect(() => depsFromEnv({ ...env, CONSOLE_TABLE: '', CALLBACK_PORTS: '80' }, clients)).toThrow(EnvError)
    expect(() => depsFromEnv({ ...env, CONSOLE_TABLE: '' }, clients)).toThrow(/CONSOLE_TABLE/)
  })
})
