// In-memory ports for tests and local development (no AWS). Semantics follow ports.ts, including the conditional
// activation and the cursor-scope check.
import type { AuditEntry, Budget, DeploymentSettings, GatewayInfo, HealthRange, HealthReport, Page, Role } from '@auto-router/console-contract'
import { createHash } from 'node:crypto'
import { HttpError } from './http.ts'
import type { Delivery, StoredVersion } from './local-types.ts'
import type {
  ActivePointer, AuditQuery, ClientDirectory, ConfigReport, ConsoleStore, Directory, DirectoryUser, Draft, GatewayReader, MemberSettings,
  MetricsReader, ObjectStore, RecordScan, RollupItem, RouterTasks, StateReport, StoredRecord, UsageStore,
} from './ports.ts'

const clone = <T>(v: T): T => structuredClone(v)
const newestFirst = (a: { ts: string }, b: { ts: string }) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0)

/** Cursor = base64url(`<scope>|<offset>`): a cursor from another scope is a 400, never another principal's page. */
export function encodeCursor(scope: string, offset: number): string { return Buffer.from(`${scope}|${offset}`).toString('base64url') }
export function decodeCursor(scope: string, cursor: string | undefined): number {
  if (cursor === undefined) return 0
  const [s, o] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  const n = Number(o)
  if (s !== scope || !Number.isInteger(n) || n < 0) throw new HttpError(400, 'bad-request', 'cursor: not valid here')
  return n
}
function page<T>(all: T[], scope: string, limit: number, cursor: string | undefined): Page<T> {
  const off = decodeCursor(scope, cursor)
  const items = all.slice(off, off + limit)
  return off + limit < all.length ? { items, nextCursor: encodeCursor(scope, off + limit) } : { items }
}

export class MemoryConsoleStore implements ConsoleStore {
  versions = new Map<number, StoredVersion>()
  active: ActivePointer | undefined
  draft: Draft | undefined
  audit: AuditEntry[] = []
  members = new Map<string, MemberSettings>()
  defaultBudget: Budget | undefined
  settings: Pick<DeploymentSettings, 'defaultBaseline'> | undefined
  async getActive() { return this.active ? { ...this.active } : undefined }
  async getVersion(n: number) { const v = this.versions.get(n); return v ? clone(v) : undefined }
  async listVersionMetas(limit: number, before?: number) {
    return [...this.versions.values()].filter((v) => before === undefined || v.meta.n < before).sort((a, b) => b.meta.n - a.meta.n).slice(0, limit).map((v) => clone(v.meta))
  }
  async latestVersion() { return Math.max(0, ...this.versions.keys()) }
  baked = new Map<string, StoredVersion>()
  async seedBakedVersion(sha8: string, v: StoredVersion) { if (!this.baked.has(sha8)) this.baked.set(sha8, clone(v)) }
  async getBakedVersion(sha8: string) { const v = this.baked.get(sha8); return v ? clone(v) : undefined }
  async activate(v: StoredVersion, expectVersion: string | undefined) {
    if (this.versions.has(v.meta.n) || this.active?.version !== expectVersion) return 'conflict' as const
    this.versions.set(v.meta.n, clone(v))
    this.active = { n: v.meta.n, version: v.meta.version, delivered: false }
    return 'ok' as const
  }
  async markDelivered(n: number, delivered: boolean) { if (this.active?.n === n) this.active.delivered = delivered }
  async getDraft() { return this.draft ? clone(this.draft) : undefined }
  async putDraft(d: Draft) { this.draft = clone(d) }
  async deleteDraft() { this.draft = undefined }
  async appendAudit(e: AuditEntry) { this.audit.push(clone(e)) }
  async listAudit(q: AuditQuery) {
    const all = this.audit.filter((e) => e.ts >= q.from && e.ts < q.to && (!q.actor || e.actor.key === q.actor || e.actor.kind === q.actor)
      && (!q.actions || q.actions.includes(e.action)) && (!q.target || e.target === q.target)).sort(newestFirst)
    return page(all.map(clone), 'audit', q.limit, q.cursor)
  }
  async getMember(key: string) { const m = this.members.get(key); return m ? clone(m) : undefined }
  async putMember(m: MemberSettings) { this.members.set(m.key, clone(m)) }
  async deleteMember(key: string) { this.members.delete(key) }
  async listMembers() { return [...this.members.values()].map(clone) }
  async getDefaultBudget() { return this.defaultBudget ? clone(this.defaultBudget) : undefined }
  async putDefaultBudget(b: Budget | undefined) { this.defaultBudget = b ? clone(b) : undefined }
  identityDelivery: Delivery | undefined
  async getIdentityDelivery() { return this.identityDelivery ? clone(this.identityDelivery) : undefined }
  async putIdentityDelivery(d: Delivery) { this.identityDelivery = clone(d) }
  async getSettings() { return this.settings ? clone(this.settings) : undefined }
  async putSettings(s: Pick<DeploymentSettings, 'defaultBaseline'>) { this.settings = clone(s) }
}

export class MemoryUsageStore implements UsageStore {
  records: StoredRecord[] = []
  rollupItems: RollupItem[] = []
  spend = new Map<string, number>()
  reports: ConfigReport[] = []
  private scan(rs: StoredRecord[], q: RecordScan) { return rs.filter((r) => r.ts >= q.from && r.ts < q.to && (!q.filter || q.filter(r))).sort(newestFirst).map(clone) }
  async principalRecords(key: string, q: RecordScan) { return page(this.scan(this.records.filter((r) => r.principal === key), q), `P#${key}`, q.limit, q.cursor) }
  async allRecords(q: RecordScan) { return page(this.scan(this.records, q), 'ALL', q.limit, q.cursor) }
  async record(reqId: string, key?: string) {
    const r = this.records.find((x) => x.reqId === reqId && (key === undefined || x.principal === key))
    return r ? clone(r) : undefined
  }
  async session(key: string, label: string, limit: number) {
    return this.records.filter((r) => r.principal === key && r.session === label).sort((a, b) => -newestFirst(a, b)).slice(0, limit).map(clone)
  }
  async rollups(from: string, to: string, key?: string) {
    return this.rollupItems.filter((r) => r.day >= from && r.day <= to && (key === undefined || r.principal === key)).map(clone)
  }
  async monthSpend(keys: readonly string[], month: string) {
    return new Map(keys.filter((k) => this.spend.has(`${k}#${month}`)).map((k) => [k, this.spend.get(`${k}#${month}`) as number]))
  }
  async configReports(limit: number) { return [...this.reports].sort(newestFirst).slice(0, limit).map(clone) }
  /** C#state: one per task (the latest). */
  states = new Map<string, StateReport>()
  async stateReports() { return [...this.states.values()].map(clone) }
}

export class MemoryObjectStore implements ObjectStore {
  objects = new Map<string, string>()
  puts: string[] = []
  failPut: ((key: string) => boolean) | undefined
  failGet: ((key: string) => boolean) | undefined
  gets: string[] = []
  async get(key: string) { return this.objects.get(key) }
  async getObject(key: string, ifNoneMatch?: string) {
    this.gets.push(key)
    if (this.failGet?.(key)) throw Object.assign(new Error('injected get failure'), { name: 'AccessDenied' })
    const body = this.objects.get(key)
    if (body === undefined) return undefined
    const etag = `"${createHash('sha1').update(body).digest('hex')}"`
    return etag === ifNoneMatch ? ('not-modified' as const) : { body, etag }
  }
  async put(key: string, body: string) {
    if (this.failPut?.(key)) throw new Error('injected put failure')
    this.puts.push(key)
    this.objects.set(key, body)
  }
}

export class MemoryDirectory implements Directory {
  users = new Map<string, DirectoryUser>()
  calls: string[] = []
  private seq = 0
  add(u: Partial<DirectoryUser> & { sub: string; groups: Role[] }): DirectoryUser {
    const user: DirectoryUser = {
      username: u.username ?? u.sub, email: `${u.sub.slice(0, 8)}@example.com`, enabled: true, status: 'CONFIRMED', mfa: false,
      createdAt: '2026-11-01T00:00:00.000Z', ...u,
    }
    this.users.set(user.username, user)
    return user
  }
  private must(username: string) {
    const u = this.users.get(username)
    if (!u) throw new HttpError(404, 'not-found', 'no such user')
    return u
  }
  async listUsers() { return [...this.users.values()].map(clone) }
  async getUser(username: string) { const u = this.users.get(username); return u ? clone(u) : undefined }
  async userBySub(sub: string) { const u = [...this.users.values()].find((x) => x.sub === sub); return u ? clone(u) : undefined }
  async createUser(u: { email: string; name: string; role: Role }) {
    if ([...this.users.values()].some((x) => x.email === u.email)) return 'exists' as const
    this.seq += 1
    const sub = `dddddddd-0000-4000-8000-a${String(this.seq).padStart(11, '0')}`
    this.calls.push(`create:${sub}`)
    return clone(this.add({ sub, username: sub, email: u.email, name: u.name, groups: [u.role], status: 'FORCE_CHANGE_PASSWORD', mfa: false }))
  }
  async resendInvite(username: string) { this.must(username); this.calls.push(`resend:${username}`) }
  async setRole(username: string, role: Role) { this.must(username).groups = [role]; this.calls.push(`role:${username}:${role}`) }
  async disable(username: string) { this.must(username).enabled = false; this.calls.push(`disable:${username}`) }
  async enable(username: string) { this.must(username).enabled = true; this.calls.push(`enable:${username}`) }
  async signOut(username: string) { this.must(username); this.calls.push(`signout:${username}`) }
  async deleteUser(username: string) { this.must(username); this.users.delete(username); this.calls.push(`delete:${username}`) }
}

export class MemoryClientDirectory implements ClientDirectory {
  clients = new Map<string, { clientId: string; name: string; secret: string }>()
  private seq = 0
  async createClient(name: string) {
    this.seq += 1
    const clientId = `svc${String(this.seq).padStart(5, '0')}abcdefghijklmnop`
    const secret = `secret-${this.seq}-${'s'.repeat(16)}`
    this.clients.set(clientId, { clientId, name, secret })
    return { clientId, secret }
  }
  async rotateSecret(clientId: string) {
    const c = this.clients.get(clientId)
    if (!c) throw new HttpError(404, 'not-found', 'no such client')
    c.secret = `${c.secret}-r`
    return { secret: c.secret }
  }
  async deleteClient(clientId: string) { this.clients.delete(clientId) }
}

export class StaticTasks implements RouterTasks {
  running: number | undefined
  constructor(running: number | undefined = 1) { this.running = running }
  async runningCount() { return this.running }
}

export class StaticGateway implements GatewayReader {
  value: GatewayInfo
  constructor(value: GatewayInfo) { this.value = value }
  async describe() { return clone(this.value) }
}
export class StaticMetrics implements MetricsReader {
  value: (range: HealthRange) => HealthReport
  constructor(value: (range: HealthRange) => HealthReport) { this.value = value }
  async health(range: HealthRange) { return clone(this.value(range)) }
}
