// S3, Cognito, AgentCore Gateway and CloudWatch/ECS adapters behind the console ports. IAM (a3's ConsoleStack) pins
// every call to this deployment's bucket keys, user pool, gateway and router service.
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import {
  AddUserPoolClientSecretCommand, AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminDeleteUserCommand, AdminDisableUserCommand,
  AdminEnableUserCommand, AdminGetUserCommand, AdminRemoveUserFromGroupCommand, AdminUserGlobalSignOutCommand,
  CreateUserPoolClientCommand, DeleteUserPoolClientCommand, DeleteUserPoolClientSecretCommand, ListUserPoolClientSecretsCommand, ListUsersCommand,
  ListUsersInGroupCommand, type AttributeType, type UserType,
} from '@aws-sdk/client-cognito-identity-provider'
import { GetGatewayCommand, GetGatewayTargetCommand, ListGatewayRulesCommand, ListGatewayTargetsCommand } from '@aws-sdk/client-bedrock-agentcore-control'
import { DescribeAlarmsCommand, GetMetricDataCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch'
import { DescribeServicesCommand } from '@aws-sdk/client-ecs'
import type { GatewayInfo, HealthRange, HealthReport, MissReason, Role, Series } from '@auto-router/console-contract'
import type { ClientDirectory, Directory, DirectoryUser, GatewayReader, MetricsReader, ObjectStore, RouterTasks } from '../ports.ts'
import type { Sender } from './dynamo.ts'

const errName = (e: unknown) => (e instanceof Error ? e.name : '')

// ---------------------------------------------------------------- S3

export class S3ObjectStore implements ObjectStore {
  private readonly s3: Sender
  private readonly bucket: string
  constructor(s3: Sender, bucket: string) { this.s3 = s3; this.bucket = bucket }
  async get(key: string): Promise<string | undefined> {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      return r.Body ? await r.Body.transformToString('utf-8') : undefined
    } catch (e) {
      if (errName(e) === 'NoSuchKey' || errName(e) === 'NotFound') return undefined
      throw e
    }
  }
  async getObject(key: string, ifNoneMatch?: string): Promise<{ body: string; etag: string } | 'not-modified' | undefined> {
    try {
      const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}) }))
      return r.Body ? { body: await r.Body.transformToString('utf-8'), etag: String(r.ETag ?? '') } : undefined
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      if (status === 304 || errName(e) === 'NotModified') return 'not-modified'
      if (errName(e) === 'NoSuchKey' || errName(e) === 'NotFound') return undefined
      throw e
    }
  }
  async put(key: string, body: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: 'application/json' }))
  }
}

// ---------------------------------------------------------------- Cognito users

const ROLES: readonly Role[] = ['admin', 'member']
const attr = (a: AttributeType[] | undefined, name: string) => a?.find((x) => x.Name === name)?.Value
/** Cognito filter strings take a double-quoted value; refuse anything that could break out of it. */
const filterValue = (v: string) => { if (!/^[^"\\\s]{1,256}$/.test(v)) throw new Error('invalid filter value'); return v }

export class CognitoDirectory implements Directory {
  private readonly idp: Sender
  private readonly pool: string
  constructor(idp: Sender, userPoolId: string) { this.idp = idp; this.pool = userPoolId }

  private async groups(): Promise<Map<string, Role[]>> {
    const out = new Map<string, Role[]>()
    for (const g of ROLES) {
      let token: string | undefined
      do {
        const r = await this.idp.send(new ListUsersInGroupCommand({ UserPoolId: this.pool, GroupName: g, ...(token ? { NextToken: token } : {}) }))
        for (const u of (r.Users ?? []) as UserType[]) if (u.Username) out.set(u.Username, [...(out.get(u.Username) ?? []), g])
        token = r.NextToken
      } while (token)
    }
    return out
  }
  private view(u: UserType, groups: Role[], mfa: boolean): DirectoryUser {
    const name = attr(u.Attributes, 'name')
    return {
      username: u.Username ?? '', sub: (attr(u.Attributes, 'sub') ?? '').toLowerCase(), email: attr(u.Attributes, 'email') ?? '', ...(name ? { name } : {}),
      enabled: u.Enabled !== false, status: u.UserStatus ?? 'UNKNOWN', groups, mfa, createdAt: u.UserCreateDate ? new Date(u.UserCreateDate).toISOString() : '',
    }
  }

  async listUsers(): Promise<DirectoryUser[]> {
    const users: UserType[] = []
    let token: string | undefined
    do {
      const r = await this.idp.send(new ListUsersCommand({ UserPoolId: this.pool, ...(token ? { PaginationToken: token } : {}) }))
      users.push(...((r.Users ?? []) as UserType[]))
      token = r.PaginationToken
    } while (token)
    const groups = await this.groups()
    // The pool has MFA off (user decision 2026-11-08): no per-user MFA lookup.
    return users.map((u) => this.view(u, groups.get(u.Username ?? '') ?? [], false))
  }
  async getUser(username: string): Promise<DirectoryUser | undefined> {
    try {
      const r = await this.idp.send(new AdminGetUserCommand({ UserPoolId: this.pool, Username: username }))
      const groups = await this.groups()
      return this.view({ Username: r.Username, Attributes: r.UserAttributes, Enabled: r.Enabled, UserStatus: r.UserStatus, UserCreateDate: r.UserCreateDate },
        groups.get(r.Username ?? username) ?? [], (r.UserMFASettingList ?? []).includes('SOFTWARE_TOKEN_MFA'))
    } catch (e) {
      if (errName(e) === 'UserNotFoundException') return undefined
      throw e
    }
  }
  async userBySub(sub: string): Promise<DirectoryUser | undefined> {
    const r = await this.idp.send(new ListUsersCommand({ UserPoolId: this.pool, Filter: `sub = "${filterValue(sub)}"`, Limit: 1 }))
    const u = (r.Users ?? [])[0] as UserType | undefined
    return u?.Username ? this.getUser(u.Username) : undefined
  }
  async createUser(u: { email: string; name: string; role: Role }): Promise<DirectoryUser | 'exists'> {
    let created: UserType | undefined
    try {
      const r = await this.idp.send(new AdminCreateUserCommand({
        UserPoolId: this.pool, Username: u.email, DesiredDeliveryMediums: ['EMAIL'],
        UserAttributes: [{ Name: 'email', Value: u.email }, { Name: 'email_verified', Value: 'true' }, { Name: 'name', Value: u.name }],
      }))
      created = r.User as UserType | undefined
    } catch (e) {
      if (errName(e) === 'UsernameExistsException' || errName(e) === 'AliasExistsException') return 'exists'
      throw e
    }
    const username = created?.Username ?? u.email
    await this.idp.send(new AdminAddUserToGroupCommand({ UserPoolId: this.pool, Username: username, GroupName: u.role }))
    return this.view(created ?? { Username: username }, [u.role], false)
  }
  async resendInvite(username: string) {
    await this.idp.send(new AdminCreateUserCommand({ UserPoolId: this.pool, Username: username, MessageAction: 'RESEND', DesiredDeliveryMediums: ['EMAIL'] }))
  }
  async setRole(username: string, role: Role) {
    await this.idp.send(new AdminAddUserToGroupCommand({ UserPoolId: this.pool, Username: username, GroupName: role }))
    for (const other of ROLES.filter((r) => r !== role)) {
      try { await this.idp.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: this.pool, Username: username, GroupName: other })) } catch (e) {
        if (errName(e) !== 'ResourceNotFoundException') throw e
      }
    }
  }
  async disable(username: string) { await this.idp.send(new AdminDisableUserCommand({ UserPoolId: this.pool, Username: username })) }
  async enable(username: string) { await this.idp.send(new AdminEnableUserCommand({ UserPoolId: this.pool, Username: username })) }
  async signOut(username: string) { await this.idp.send(new AdminUserGlobalSignOutCommand({ UserPoolId: this.pool, Username: username })) }
  async deleteUser(username: string) { await this.idp.send(new AdminDeleteUserCommand({ UserPoolId: this.pool, Username: username })) }
}

// ---------------------------------------------------------------- Cognito app clients (service clients)

/** CreateUserPoolClient input of a console-created service client (see createClient). */
export function serviceClientInput(userPoolId: string, prefix: string, invokeScope: string, name: string) {
  return {
    UserPoolId: userPoolId, ClientName: `${prefix}-svc-${name.replace(/[^A-Za-z0-9._-]+/g, '-')}`.slice(0, 128), GenerateSecret: true,
    AllowedOAuthFlows: ['client_credentials' as const], AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthScopes: [invokeScope],
    SupportedIdentityProviders: ['COGNITO'], ExplicitAuthFlows: [], CallbackURLs: [], LogoutURLs: [],
  }
}

export class CognitoClientDirectory implements ClientDirectory {
  private readonly idp: Sender
  private readonly pool: string
  private readonly prefix: string
  private readonly invokeScope: string
  private readonly reserved: ReadonlySet<string>
  /** `reserved`: client ids the console must never change (agent, cli, console): IAM cannot express that. */
  constructor(idp: Sender, o: { userPoolId: string; prefix: string; invokeScope: string; reserved: readonly string[] }) {
    this.idp = idp; this.pool = o.userPoolId; this.prefix = o.prefix; this.invokeScope = o.invokeScope; this.reserved = new Set(o.reserved)
  }
  private guard(clientId: string) { if (this.reserved.has(clientId)) throw new Error('reserved app client') }
  /**
   * The service-client shape is fixed here (IAM cannot constrain CreateUserPoolClient; 0d stack review): client
   * credentials only, exactly the invoke scope, a generated secret, no callback or logout URLs, no explicit (user) auth
   * flows, Cognito as the only provider. No admin input reaches these fields; only the name. Rotation adds and deletes
   * secrets and never updates the client, so these settings stay.
   */
  async createClient(name: string) {
    const r = await this.idp.send(new CreateUserPoolClientCommand(serviceClientInput(this.pool, this.prefix, this.invokeScope, name)))
    const c = r.UserPoolClient
    if (!c?.ClientId || !c.ClientSecret) throw new Error('CreateUserPoolClient returned no secret')
    return { clientId: c.ClientId, secret: c.ClientSecret }
  }
  /** Adds a new secret, then deletes every older one: the old secret stops working at once. */
  async rotateSecret(clientId: string) {
    this.guard(clientId)
    const before = await this.idp.send(new ListUserPoolClientSecretsCommand({ UserPoolId: this.pool, ClientId: clientId }))
    const added = await this.idp.send(new AddUserPoolClientSecretCommand({ UserPoolId: this.pool, ClientId: clientId }))
    const secret = added.ClientSecretDescriptor?.ClientSecretValue
    const newId = added.ClientSecretDescriptor?.ClientSecretId
    if (!secret) throw new Error('AddUserPoolClientSecret returned no secret')
    for (const s of before.ClientSecrets ?? []) {
      if (s.ClientSecretId && s.ClientSecretId !== newId) await this.idp.send(new DeleteUserPoolClientSecretCommand({ UserPoolId: this.pool, ClientId: clientId, ClientSecretId: s.ClientSecretId }))
    }
    return { secret }
  }
  async deleteClient(clientId: string) {
    this.guard(clientId)
    await this.idp.send(new DeleteUserPoolClientCommand({ UserPoolId: this.pool, ClientId: clientId }))
  }
}

// ---------------------------------------------------------------- AgentCore gateway (read only)

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : undefined)
/** Every `allowedRequestHeaders` list anywhere in a target configuration. */
function headersIn(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) headersIn(x, out)
  else if (obj(v)) for (const [k, x] of Object.entries(v as Obj)) {
    if (k === 'allowedRequestHeaders' && Array.isArray(x)) for (const h of x) { if (typeof h === 'string') out.add(h.toLowerCase()) } else headersIn(x, out)
  }
  return out
}
function targetsOf(actions: unknown): { target?: string; fallback: string[] } {
  const a = (Array.isArray(actions) ? actions : [])[0]
  const route = obj(obj(obj(a)?.routeToTarget)?.staticRoute)
  const fb = obj(route?.fallback)
  const chain = (Array.isArray(fb?.targetFallback) ? fb.targetFallback : []).map((f) => { const o = obj(f); return `${String(o?.targetName ?? '?')}${o?.model ? ` (${String(o.model)})` : ''}` })
  return { ...(typeof route?.targetName === 'string' ? { target: route.targetName } : {}), fallback: chain }
}

export const GATEWAY_CDK_PARAMETERS: Record<string, string> = {
  authorizer: 'RouterStack (Cognito pool, scope <prefix>/invoke)', targets: 'RouterStack (router target, fallback target)',
  rules: 'RouterStack (catch-all and 5XX fallback rules)', forwardedHeaders: 'RouterStack (target allowedRequestHeaders)',
}

export class AgentCoreGateway implements GatewayReader {
  private readonly ctl: Sender
  private readonly gatewayId: string
  constructor(ctl: Sender, gatewayId: string) { this.ctl = ctl; this.gatewayId = gatewayId }
  async describe(): Promise<GatewayInfo> {
    const g = await this.ctl.send(new GetGatewayCommand({ gatewayIdentifier: this.gatewayId }))
    const jwt = obj(obj(g.authorizerConfiguration)?.customJWTAuthorizer)
    const list = await this.ctl.send(new ListGatewayTargetsCommand({ gatewayIdentifier: this.gatewayId }))
    const headers = new Set<string>()
    const details = new Map<string, Obj>()
    for (const t of (list.items ?? []) as Obj[]) {
      const d = await this.ctl.send(new GetGatewayTargetCommand({ gatewayIdentifier: this.gatewayId, targetId: String(t.targetId) }))
      details.set(String(t.name), d as Obj)
      headersIn(d, headers)
    }
    const rules = await this.ctl.send(new ListGatewayRulesCommand({ gatewayIdentifier: this.gatewayId }))
    const ruleRows = ((rules.gatewayRules ?? []) as Obj[]).map((r) => ({ r, t: targetsOf(r.actions) })).sort((a, b) => Number(a.r.priority ?? 0) - Number(b.r.priority ?? 0))
    const fallbackNames = new Set(ruleRows.flatMap((x) => x.t.fallback.map((f) => f.split(' ')[0] as string)))
    const routerName = ruleRows.map((x) => x.t.target).find((t) => t && !fallbackNames.has(t))
    return {
      url: String(g.gatewayUrl ?? ''), id: String(g.gatewayId ?? this.gatewayId), status: String(g.status ?? 'UNKNOWN'),
      ...(g.updatedAt ? { updatedAt: new Date(g.updatedAt as Date).toISOString() } : {}),
      authorizer: { discoveryUrl: String(jwt?.discoveryUrl ?? ''), allowedScopes: Array.isArray(jwt?.allowedScopes) ? (jwt.allowedScopes as string[]) : [] },
      targets: [...details.entries()].map(([name, d]) => ({
        name, role: name === routerName || !fallbackNames.has(name) ? 'router' as const : 'fallback' as const, detail: `${String(d.status ?? '')} ${String(d.description ?? '')}`.trim(),
      })),
      rules: ruleRows.map(({ r, t }) => ({ priority: Number(r.priority ?? 0), match: JSON.stringify(r.conditions ?? []).slice(0, 300), target: t.target ?? '?' })),
      fallbackChain: [...new Set(ruleRows.flatMap((x) => x.t.fallback))],
      forwardedHeaders: [...headers].sort(), cdkParameters: GATEWAY_CDK_PARAMETERS,
    }
  }
}

// ---------------------------------------------------------------- ECS: router running tasks

export class EcsRouterTasks implements RouterTasks {
  private readonly ecs: Sender
  private readonly cluster: string
  private readonly service: string
  constructor(ecs: Sender, cluster: string, service: string) { this.ecs = ecs; this.cluster = cluster; this.service = service }
  async runningCount(): Promise<number | undefined> {
    try {
      const r = await this.ecs.send(new DescribeServicesCommand({ cluster: this.cluster, services: [this.service] }))
      const n = (r.services ?? [])[0]?.runningCount
      return typeof n === 'number' ? n : undefined
    } catch { return undefined }
  }
}

// ---------------------------------------------------------------- CloudWatch + ECS health

const RANGE: Record<HealthRange, { minutes: number; period: number }> = { '1h': { minutes: 60, period: 60 }, '6h': { minutes: 360, period: 300 }, '24h': { minutes: 1440, period: 900 }, '7d': { minutes: 10080, period: 3600 } }
const MISS: readonly MissReason[] = ['model_changed', 'ttl_expired', 'prefix_changed', 'unknown']

export class CloudWatchHealth implements MetricsReader {
  private readonly cw: Sender
  private readonly ecs: Sender
  private readonly o: { namespace: string; cluster: string; service: string; alarmPrefix: string; activeVersion: () => Promise<{ active: string; reported?: string; rejections: number }> }
  constructor(cw: Sender, ecs: Sender, o: CloudWatchHealth['o']) { this.cw = cw; this.ecs = ecs; this.o = o }

  async health(range: HealthRange): Promise<HealthReport> {
    const { minutes, period } = RANGE[range]
    const end = new Date()
    const start = new Date(end.getTime() - minutes * 60_000)
    const ns = this.o.namespace
    // SEARCH sums every series of a dimension set (the router's EMF uses [Mode], [StatusClass], [MissReason]).
    const sum = (id: string, metric: string, dims = 'Mode', extra = ''): MetricDataQuery => ({ Id: id, Expression: `SUM(SEARCH('{${ns},${dims}} MetricName="${metric}"${extra}', 'Sum', ${period}))`, ReturnData: true })
    const pct = (id: string, metric: string, stat: string): MetricDataQuery => ({ Id: id, Expression: `MAX(SEARCH('{${ns},Mode} MetricName="${metric}"', '${stat}', ${period}))`, ReturnData: true })
    const queries: MetricDataQuery[] = [
      sum('req', 'Requests'), sum('s4', 'Requests', 'StatusClass', ' StatusClass="4xx"'), sum('s5', 'Requests', 'StatusClass', ' StatusClass="5xx"'),
      sum('fo', 'Failovers'), sum('sw', 'Switches'), sum('rd', 'CacheReadTokens'), sum('pt', 'PromptTokens'),
      pct('o50', 'OverheadMs', 'p50'), pct('o99', 'OverheadMs', 'p99'), pct('t50', 'UpstreamTtfbMs', 'p50'), pct('t99', 'UpstreamTtfbMs', 'p99'),
      pct('a50', 'AssessorLatencyMs', 'p50'), pct('a95', 'AssessorLatencyMs', 'p95'), sum('ac', 'AssessorConsults'), sum('au', 'AssessorUnavailable'),
      ...MISS.map((m, i) => sum(`m${i}`, 'Misses', 'MissReason', ` MissReason="${m}"`)),
    ]
    const series = new Map<string, Series[]>()
    let token: string | undefined
    do {
      const r = await this.cw.send(new GetMetricDataCommand({ StartTime: start, EndTime: end, MetricDataQueries: queries, ScanBy: 'TimestampAscending', ...(token ? { NextToken: token } : {}) }))
      for (const m of r.MetricDataResults ?? []) {
        const pts = (m.Timestamps ?? []).map((t: Date, i: number) => ({ t: new Date(t).toISOString(), v: Number(m.Values?.[i] ?? 0) }))
        series.set(String(m.Id), [...(series.get(String(m.Id)) ?? []), ...pts])
      }
      token = r.NextToken
    } while (token)
    const s = (id: string) => series.get(id) ?? []
    const total = (id: string) => s(id).reduce((a, p) => a + p.v, 0)
    const perMin = (id: string) => s(id).map((p) => ({ t: p.t, v: p.v / (period / 60) }))
    const ratio = (num: string, den: string) => { const d = new Map(s(den).map((p) => [p.t, p.v])); return s(num).map((p) => ({ t: p.t, v: (d.get(p.t) ?? 0) > 0 ? p.v / (d.get(p.t) as number) : 0 })) }
    const last = (id: string) => s(id).at(-1)?.v
    const svc = await this.ecs.send(new DescribeServicesCommand({ cluster: this.o.cluster, services: [this.o.service] }))
    const sv = (svc.services ?? [])[0]
    const running = Number(sv?.runningCount ?? 0)
    const desired = Number(sv?.desiredCount ?? 0)
    const alarms = await this.cw.send(new DescribeAlarmsCommand({ AlarmNamePrefix: this.o.alarmPrefix, StateValue: 'ALARM' }))
    const cfg = await this.o.activeVersion()
    const consults = total('ac')
    return {
      range, tasks: { running, desired }, requestsPerMin: perMin('req'), rate4xx: ratio('s4', 'req'), rate5xx: ratio('s5', 'req'), failovers: s('fo'),
      overheadP50: s('o50'), overheadP99: s('o99'), ttfbP50: s('t50'), ttfbP99: s('t99'), hitRate: ratio('rd', 'pt'), switches: s('sw'),
      missesByReason: Object.fromEntries(MISS.map((m, i) => [m, total(`m${i}`)]).filter(([, v]) => (v as number) > 0)),
      assessor: { ...(last('a50') !== undefined ? { latencyP50Ms: last('a50') } : {}), ...(last('a95') !== undefined ? { latencyP95Ms: last('a95') } : {}),
        ...(consults > 0 ? { unavailableRate: total('au') / consults } : {}) },
      fallbackSigns: { router5xx: total('s5'), unhealthyTargets: Math.max(0, desired - running), tasksBelowDesired: running < desired },
      config: { activeVersion: cfg.active, ...(cfg.reported ? { reportedVersion: cfg.reported } : {}), rejections: cfg.rejections },
      alarms: ((alarms.MetricAlarms ?? []) as Array<{ AlarmName?: string; StateValue?: string; StateUpdatedTimestamp?: Date }>).map((a) => ({
        name: a.AlarmName ?? '', state: (a.StateValue ?? 'ALARM') as 'ALARM', since: a.StateUpdatedTimestamp ? new Date(a.StateUpdatedTimestamp).toISOString() : '',
      })),
    }
  }
}
