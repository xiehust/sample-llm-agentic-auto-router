// Deterministic mock dataset: two weeks of router records for a few callers, priced with the repository's real
// catalog and costOf, plus members, service clients, config versions, packs, audit entries and health series.
// Record shapes follow the router log line (packages/router/src/account.ts) with the design v1 §2.2 additions.

import type {
  ActiveAssessorSettings, Delivery, AuditEntry, Baseline, Budget, CallerRef, Cap, ConfigDocument, ConfigVersionMeta, Dialect, GatewayInfo, Member, PackEntry,
  IdentityKeysReason, IdentityKeysState, PacksResponse, PrincipalEntry, PrincipalKey, RecordDetail, RouterConfigState, ServiceClient, Tier,
} from '@auto-router/console-contract'

/** Router signing-key evidence (73: fresh state lines per task, ECS runningCount); one demo state per refusal reason. */
export const KEY_STATES: Record<'loaded' | IdentityKeysReason, IdentityKeysState> = {
  loaded: { loaded: true, fresh: 2, running: 2, withKeys: 2 },
  'no-fresh-task': { loaded: false, reason: 'no-fresh-task', fresh: 0, running: 2, withKeys: 0 },
  partial: { loaded: false, reason: 'partial', fresh: 1, running: 2, withKeys: 1 },
  'not-configured': { loaded: false, reason: 'not-configured', fresh: 2, running: 2, withKeys: 0, task: 'router/1a2b3c' },
  'task-without-keys': { loaded: false, reason: 'task-without-keys', fresh: 2, running: 2, withKeys: 1, task: 'router/4d5e6f' },
}
import { loadPack, packDirs, renderSystem, type PackName } from '@auto-router/assessor'
import { costOf, findModel, loadCatalog, type NormalizedUsage, type PriceCatalog } from '@auto-router/pricing'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { MOCK_ACCOUNTS } from './idp.ts'

export const REGION = 'ap-southeast-1'
export const PREFIX = 'llmar'
const DAY_MS = 86_400_000

/** mulberry32: small seeded PRNG so every run produces the same data. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hex16 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

export interface Savings {
  A: number
  Astar: number
  B: Record<Baseline, number>
  baseTier: Record<Baseline, Tier>
  X: number
  routingSwitch: boolean
  otherCold: number
  Cnet: number
  capped: boolean
  projected?: { A: number; tier: Tier }
}

/** A stored record: the API shape plus the owner key and the precomputed savings terms (never sent as such). */
export interface StoredRecord { p: PrincipalKey; detail: RecordDetail; sv?: Savings }

export interface Principal { key: PrincipalKey; caller: CallerRef }

export interface MockDb {
  now: number
  catalog: PriceCatalog
  records: StoredRecord[]
  principals: Map<PrincipalKey, Principal>
  members: Member[]
  memberHistory: Map<string, Array<{ ts: string; status: Member['status'] | 'role'; by?: string; detail?: string }>>
  clients: ServiceClient[]
  versions: Array<ConfigVersionMeta & { document: ConfigDocument }>
  /** config/baked.json (0d-effective-config §2): the deploy-time document; unreadable in 'unknown' mode. */
  baked: ConfigDocument
  bakedReadable: boolean
  /** Latest router config line per task (ReportedConfig source). */
  reportedMismatch: boolean
  /** Config reads fail: 404 (phase-2 console-api with no active doc) or 503 config-unavailable (73). */
  configFailure?: 404 | 503
  /** S3 delivery of config/active.json and of identity/*.json (design §2.3a). */
  configDelivery: Delivery
  identityDelivery: Delivery
  /** Router reports its identity signing keys loaded (Require is refused until then). */
  identityKeys: IdentityKeysState
  /** identity/principals.json: per-principal group and tier limit (design 0.16). */
  principalEntries: Map<PrincipalKey, PrincipalEntry>
  draft?: { document: ConfigDocument; author: string; updatedAt: string; baseVersion: string }
  router: RouterConfigState
  universe: string[]
  packs: PacksResponse
  audit: AuditEntry[]
  settings: { retentionDays: number; defaultBaseline: Baseline }
  defaultBudget?: Budget
  gateway: GatewayInfo
}

export const POLICY_FILE = new URL('../../router/config/policy.default.json', import.meta.url)

function policyDoc(mode: 'observe' | 'auto', version: string): Record<string, unknown> {
  const p = JSON.parse(readFileSync(POLICY_FILE, 'utf8')) as Record<string, unknown>
  return { ...p, mode, version }
}

/** Config versions are "<n>-<compact ISO time>" (design §2.1; the router rejects other forms). */
export const configVersion = (n: number, at: number) => `${n}-${new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`

export function configDocument(mode: 'observe' | 'auto', version: string, packVersion: string): ConfigDocument {
  const assessor: ActiveAssessorSettings = { mode: 'observe', pack: 'v2.2', packVersion, model: 'global.openai.gpt-6-luna', threshold: 0.7, timeoutMs: 2500, autoRules: 'pack' }
  return {
    schemaVersion: 1,
    version,
    policy: policyDoc(mode, `policy-${version}`),
    assessor,
    identity: { mode: 'observe' },
    access: { groups: { member: { maxTier: 'frontier' }, service: { maxTier: 'standard' } } },
  }
}

interface Pool { defaultTier: Tier; models: Array<{ model: string; tier: Tier }> }

/** Pools from the default policy, with each model's tier (explicit, else the catalog's). */
export function pools(catalog: PriceCatalog): Record<Dialect, Pool> {
  const p = JSON.parse(readFileSync(POLICY_FILE, 'utf8')) as { pools: Record<Dialect, { defaultTier: Tier; models: Array<{ model: string; tier?: Tier }> }> }
  const out = {} as Record<Dialect, Pool>
  for (const [d, pool] of Object.entries(p.pools) as Array<[Dialect, { defaultTier: Tier; models: Array<{ model: string; tier?: Tier }> }]>) {
    out[d] = { defaultTier: pool.defaultTier, models: pool.models.map((m) => ({ model: m.model, tier: m.tier ?? (findModel(catalog, m.model)?.tier as Tier) })) }
  }
  return out
}

const modelOfTier = (pool: Pool, t: Tier): string => (pool.models.find((m) => m.tier === t) ?? pool.models[0]!).model
const ttlOf = (d: Dialect) => (d === 'anthropic-messages' ? '5m' as const : '30m' as const)

function packEntry(name: PackName): PackEntry {
  const pack = loadPack(packDirs[name])
  const { system, packVersion } = renderSystem(pack)
  const byTier: Partial<Record<Tier, number>> = {}
  for (const e of pack.examples) byTier[e.tier] = (byTier[e.tier] ?? 0) + 1
  return {
    name, id: pack.id, packVersion, card: pack.card, output: pack.output,
    mapping: (pack.mapping ?? {}) as Record<string, unknown>, mappingSource: pack.mapping ? 'pack' : 'default',
    rules: pack.rules.map((r) => ({ ...r })), autoCapable: pack.rules.some((r) => r.enabled && r.auto),
    examples: { count: pack.examples.length, byTier }, systemChars: system.length,
  }
}

/** Sorted-key JSON, as 0d's canonicalJson (the baked version hashes it). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}

/** The baked document: deploy-time policy, identity observe, assessor observe, no caps; version 0-baked.<sha8>. */
export function bakedDocument(packVersion: string): ConfigDocument {
  const base = configDocument('observe', 'tmp', packVersion)
  const doc: ConfigDocument = { ...base, access: { groups: {} } }
  const { version: _v, ...rest } = doc
  const version = `0-baked.${createHash('sha256').update(canonicalJson(rest)).digest('hex').slice(0, 8)}`
  return { ...doc, version, policy: { ...doc.policy, version: `policy-${version}` } }
}

/** Effective-config demo modes: console versions active (document), none (baked), partial doc + unreadable baked. */
export type EffectiveMode = 'document' | 'baked' | 'unknown'

export function buildDb(now: number = Date.now(), effectiveMode: EffectiveMode = 'document'): MockDb {
  const catalog = loadCatalog(REGION)
  const pool = pools(catalog)
  const price = (m: string) => {
    const p = findModel(catalog, m)
    if (!p) throw new Error(`mock: ${m} not in catalog`)
    return p
  }
  const today0 = Math.floor(now / DAY_MS) * DAY_MS
  const iso = (t: number) => new Date(t).toISOString()

  // ---- principals
  const principals = new Map<PrincipalKey, Principal>()
  for (const a of MOCK_ACCOUNTS.filter((x) => x.groups.length > 0)) {
    principals.set(`user:${a.sub}`, { key: `user:${a.sub}`, caller: { key: `user:${a.sub}`, kind: 'user', name: a.name, email: a.email } })
  }
  principals.set('client:c-ci', { key: 'client:c-ci', caller: { key: 'client:c-ci', kind: 'client', name: 'ci-bot' } })
  principals.set('none', { key: 'none', caller: { key: 'none', kind: 'none' } })

  // ---- config versions: v1 observe (30 days ago), v2 auto (7 days ago)
  const v1At = today0 - 30 * DAY_MS + 9 * 3600_000
  const v2At = today0 - 7 * DAY_MS + 10 * 3600_000
  const packs: PacksResponse = { schemaVersion: 1, default: 'v2.2', packs: (Object.keys(packDirs) as PackName[]).map(packEntry) }
  const v22 = packs.packs.find((p) => p.name === 'v2.2')!
  const V1 = configVersion(1, v1At)
  const V2 = configVersion(2, v2At)
  const baked = bakedDocument(v22.packVersion)
  const consoleVersions: MockDb['versions'] = [
    { version: V1, n: 1, author: 'Ada Admin', createdAt: iso(v1At), comment: 'Initial configuration (observe).', changed: ['policy', 'assessor', 'identity', 'access'], document: configDocument('observe', V1, v22.packVersion) },
    { version: V2, n: 2, author: 'Ada Admin', createdAt: iso(v2At), comment: 'Switch the router to auto after the savings review.', changed: ['policy'], document: configDocument('auto', V2, v22.packVersion) },
  ]
  // baked: no console version yet, so the active document is the baked one (n 0, author 'cdk').
  // unknown: a hand-written document with only policy and access, and config/baked.json unreadable.
  const versions: MockDb['versions'] = effectiveMode === 'document' ? consoleVersions
    : effectiveMode === 'baked' ? [{ version: baked.version, n: 0, author: 'cdk', createdAt: iso(v1At - DAY_MS), comment: 'Deploy-time configuration (config/baked.json).', changed: [], document: baked }]
    : [{ version: V1, n: 1, author: 'Ada Admin', createdAt: iso(v1At), comment: 'Hand-written partial document.', changed: ['policy', 'access'],
      document: (({ assessor: _a, identity: _i, ...rest }) => rest)(configDocument('auto', V1, v22.packVersion)) as ConfigDocument }]

  // ---- records
  const r = rng(20261108)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T
  const records: StoredRecord[] = []
  const owners: Array<{ key: PrincipalKey; weight: number }> = [
    { key: 'user:u-mia', weight: 2 }, { key: 'user:u-noah', weight: 1 }, { key: 'user:u-admin', weight: 1 }, { key: 'client:c-ci', weight: 1 }, { key: 'none', weight: 1 },
  ]
  let seq = 0
  for (let day = -13; day <= 0; day++) {
    for (const o of owners) {
      const sessions = Math.floor(r() * (o.weight + 1.2))
      for (let s = 0; s < sessions; s++) {
        const dialect: Dialect = r() < 0.6 ? 'anthropic-messages' : r() < 0.75 ? 'openai-responses' : 'openai-chat'
        const pl = pool[dialect]
        const sessionLabel = hex16(`session:${o.key}:${day}:${s}`)
        const root = hex16(`lineage:${sessionLabel}:root`)
        const sub = r() < 0.3 ? hex16(`lineage:${sessionLabel}:sub`) : undefined
        const reqRoll = r()
        const requested = reqRoll < 0.7 ? 'auto' : reqRoll < 0.8 ? 'auto:fast' : reqRoll < 0.88 ? 'auto:frontier' : reqRoll < 0.95 ? modelOfTier(pl, 'standard') : 'other'
        const n = 4 + Math.floor(r() * 14)
        let t = today0 + day * DAY_MS + (7 + Math.floor(r() * 12)) * 3600_000 + Math.floor(r() * 3600_000)
        if (t > now - 120_000) t = now - 120_000 - n * 90_000
        const cur = new Map<string, { model: string; tier: Tier; prompt: number }>()
        for (let i = 0; i < n; i++) {
          t += 20_000 + Math.floor(r() * 220_000)
          if (t > now - 60_000) break
          const lineage = sub && i > 2 && r() < 0.35 ? sub : root
          const mode: 'observe' | 'auto' = t >= v2At ? 'auto' : 'observe'
          const cfgVersion = t >= v2At ? V2 : V1
          const reqId = `r-${(++seq).toString().padStart(5, '0')}-${hex16(`${sessionLabel}:${i}`).slice(0, 8)}`
          const base: RecordDetail = {
            ts: iso(t), reqId, kind: 'model', status: 200, session: sessionLabel, lineage, dialect, requested, mode, flags: {},
            identity: o.key === 'none' ? 'missing' : 'verified', stream: r() < 0.8, bodyBytes: 20_000 + Math.floor(r() * 400_000),
            configVersion: cfgVersion, catalogVersion: catalog.version,
          }
          if (o.key !== 'none') base.caller = principals.get(o.key)!.caller
          if (requested === 'other') {
            records.push({ p: o.key, detail: { ...base, kind: 'rejected', status: 400, errorCode: 'pin-not-allowed', requested: 'other', requestedLength: 23 } })
            break
          }
          // Desired tier: alias tier, assessor/default for auto.
          const prev = cur.get(lineage)
          const isPin = requested.startsWith('global.')
          const aliasTier: Tier | undefined = requested === 'auto:fast' ? 'fast' : requested === 'auto:frontier' ? 'frontier' : undefined
          let desired: Tier = isPin ? 'standard' : aliasTier ?? (prev?.tier ?? (r() < 0.25 ? 'fast' : r() < 0.8 ? 'standard' : 'frontier'))
          let point: RecordDetail['point'] = prev ? (r() < 0.6 ? 'hard-lock-tool-loop' : 'user-turn') : lineage === root ? 'session-start' : 'subagent-start'
          let action: RecordDetail['action'] = prev ? 'retain' : 'initialize'
          let code = prev ? (point === 'hard-lock-tool-loop' ? 'hard-lock' : 'retain:same-tier') : lineage === root ? 'session-start' : 'subagent-start'
          if (prev && point === 'user-turn' && !aliasTier && !isPin && r() < 0.18) {
            desired = prev.tier === 'standard' ? (r() < 0.5 ? 'fast' : 'frontier') : 'standard'
            code = desired === 'frontier' || (prev.tier === 'fast' && desired === 'standard') ? 'upgrade' : 'downgrade'
          }
          // Tier limit (design 0.16): Noah is capped at standard.
          let capped = false
          if (o.key === 'user:u-noah' && desired === 'frontier') { desired = 'standard'; capped = true; code = 'access-cap' }
          const chosen = isPin ? requested : modelOfTier(pl, desired)
          const served0 = mode === 'observe' ? modelOfTier(pl, pl.defaultTier) : chosen
          if (isPin) { action = 'pin'; point = 'pinned'; code = 'pin:concrete' }
          else if (prev && served0 !== prev.model) action = 'switch'
          const wouldChoose = mode === 'observe' ? chosen : undefined
          const failover = r() < 0.025
          const served = failover ? `${served0.replace(/^global\./, 'apac.')}` : served0
          // A failover to another profile of the same model bills like the model itself.
          const servedPrice = price(served0)
          const tier = (servedPrice.tier as Tier)
          // Usage.
          const prompt = Math.round(9_000 + (prev?.prompt ?? 0) * 0.92 + r() * 6_000 + i * 900)
          const cold = !prev || action === 'switch' || failover
          const ttlMiss = !cold && r() < 0.05
          const read = cold || ttlMiss ? 0 : Math.round(prompt * (0.82 + r() * 0.12))
          const uncached = Math.round(Math.min(prompt - read, 300 + r() * 1500))
          const write = Math.max(0, prompt - read - uncached)
          const output = Math.round(150 + r() * 2400)
          const usage: NormalizedUsage = { uncachedInputTokens: uncached, cacheReadTokens: read, cacheWriteTokens: { [ttlOf(dialect)]: write }, outputTokens: output, promptTokens: prompt }
          if (dialect !== 'anthropic-messages') usage.reasoningTokens = Math.round(output * 0.3)
          const status = r() < 0.01 ? 503 : r() < 0.012 ? 499 : 200
          const cost = costOf(usage, servedPrice)
          const d: RecordDetail = {
            ...base, status, kind: status >= 500 ? 'error' : 'model', action, point, servedModel: served, tier,
            decision: {
              action, point, mode, model: chosen, policyVersion: `policy-${cfgVersion}`,
              reason: `${mode === 'observe' ? 'observe-default: ' : ''}${code}: ${code === 'access-cap' ? 'tier frontier above the caller limit standard' : `tier ${desired} via ${aliasTier ? 'alias' : prev ? 'session-tier' : 'default'}`}; family=${dialect === 'anthropic-messages' ? 'claude' : 'gpt'} est=${prompt}`,
              code, source: aliasTier ? 'alias' : prev ? 'session-tier' : 'default', reasonFlags: mode === 'observe' ? ['observe-default'] : [],
              estimate: { stayUsd: cost.total, switchUsd: cost.total * (1.1 + r()), horizonCalls: 8 },
            },
            timing: { bodyReadMs: 2 + Math.floor(r() * 9), decideMs: 1 + Math.floor(r() * 3), overheadMs: 3 + Math.floor(r() * 6), upstreamTtfbMs: 400 + Math.floor(r() * 2400), durationMs: 2_000 + Math.floor(r() * 40_000) },
          }
          if (wouldChoose) {
            d.wouldChoose = wouldChoose
            d.decision!.wouldChoose = wouldChoose
            d.decision!.projected = { model: wouldChoose, switch: !!prev && prev.model !== wouldChoose }
          }
          if (capped) { d.tierLimit = { from: modelOfTier(pl, 'frontier'), to: chosen, maxTier: 'standard' }; d.flags.capped = true }
          if (action === 'switch' && prev) { d.switchedFrom = { model: prev.model, warmTokens: Math.round(prev.prompt * 0.9) }; d.flags.switch = true }
          if (failover) { d.failoverDetail = { from: served0, to: served, status: 429 }; d.flags.failover = true }
          if (ttlMiss) { d.missDetail = { reason: 'ttl_expired', expectedTokens: Math.round(prompt * 0.85), readTokens: 0 }; d.flags.miss = 'ttl_expired' }
          if (isPin) d.flags.hint = true
          if (status === 499) {
            d.clientAborted = true; d.flags.aborted = true; d.flags.unmetered = true
            d.unmeteredBound = { upperBoundUsd: cost.total * 1.4, partial: r() < 0.3 }
          } else if (status === 200) {
            d.usage = usage
            d.cost = cost
            d.costUsd = cost.total
            d.promptTokens = prompt
            d.outputTokens = output
            d.hitRate = read / prompt
            d.bar = { read, write, uncached }
          } else {
            d.errorCode = 'upstream-503'
          }
          // Assessor (observe mode, consulted on user-text turns of auto requests).
          let X = 0
          if (!isPin && !aliasTier && (point === 'session-start' || point === 'user-turn' || point === 'subagent-start')) {
            const rule = pick(v22.rules)
            const ok = r() > 0.06
            const a = {
              id: `assessor/v2.2@${v22.packVersion.split('+')[1]}`, mode: 'observe' as const, autoRules: 'pack' as const, status: ok ? 'ok' as const : 'unavailable' as const,
              packVersion: v22.packVersion, latencyMs: 280 + Math.floor(r() * 900), applied: false, called: true, threshold: 0.7,
              ...(ok ? { tier: rule.tier, proposedTier: rule.tier, confidence: Math.round((0.55 + r() * 0.4) * 100) / 100, basis: [rule.id], outcome: rule.tier, costUsd: 0.0004 + r() * 0.0016 }
                : { outcome: 'unavailable:timeout' }),
            }
            d.assessorDetail = a
            d.flags.assessor = ok ? rule.tier : 'no-opinion'
            X = 'costUsd' in a ? a.costUsd : 0
          }
          // Savings terms (0d §1.5, simplified where the mock has no cache state: warm-equivalent from switchedFrom).
          let sv: Savings | undefined
          if (d.usage && d.cost) {
            const routingSwitch = mode === 'auto' && action === 'switch' && !failover && !capped
            const warm = d.switchedFrom?.warmTokens ?? 0
            const uStar: NormalizedUsage = routingSwitch ? warmAdj(usage, warm) : usage
            const A = cost.total
            const Astar = routingSwitch ? costOf(uStar, servedPrice).total : A
            const baseTier: Record<Baseline, Tier> = {
              static: aliasTier ?? (isPin ? tier : pl.defaultTier), standard: 'standard', frontier: 'frontier', 'observe-default': pl.defaultTier,
            }
            const B = {} as Record<Baseline, number>
            for (const k of Object.keys(baseTier) as Baseline[]) {
              const bm = k === 'static' && isPin ? requested : modelOfTier(pl, baseTier[k])
              B[k] = costOf(uStar, price(bm)).total
            }
            const p0 = servedPrice.price
            const ttl = ttlOf(dialect)
            const Cnet = (read * (p0.input - p0.cacheRead) - write * ((p0.cacheWrite[ttl] ?? p0.input) - p0.input)) / 1e6
            const otherCold = !routingSwitch && (failover || (action === 'switch' && mode === 'auto')) ? write * ((p0.cacheWrite[ttl] ?? p0.input) - p0.cacheRead) / 1e6 * 0.5 : 0
            sv = { A, Astar, B, baseTier, X, routingSwitch, otherCold, Cnet, capped }
            if (wouldChoose) sv.projected = { A: costOf(usage, price(wouldChoose)).total, tier: price(wouldChoose).tier as Tier }
          }
          records.push(sv ? { p: o.key, detail: d, sv } : { p: o.key, detail: d })
          cur.set(lineage, { model: served0, tier: price(served0).tier as Tier, prompt })
        }
      }
    }
  }
  records.sort((a, b) => a.detail.ts.localeCompare(b.detail.ts))

  // ---- members and clients
  const lastReq = (key: PrincipalKey) => [...records].reverse().find((x) => x.p === key)?.detail.ts
  const month = iso(now).slice(0, 7)
  const monthCost = (key: PrincipalKey) => records.filter((x) => x.p === key && x.detail.ts.startsWith(month)).reduce((s, x) => s + (x.detail.costUsd ?? 0), 0)
  const memberOf = (sub: string, role: Member['role'], extra: Partial<Member> = {}): Member => {
    const a = MOCK_ACCOUNTS.find((x) => x.sub === sub)!
    const m: Member = {
      id: sub, username: a.username, name: a.name, email: a.email, role, status: 'active', mfa: 'enrolled', createdAt: iso(v1At - DAY_MS),
      costThisMonthUsd: monthCost(`user:${sub}`), ...extra,
    }
    const lr = lastReq(`user:${sub}`)
    if (lr) m.lastRequestAt = lr
    return m
  }
  const capNoah: Cap = { maxTier: 'standard' }
  const members: Member[] = [
    memberOf('u-admin', 'admin'),
    memberOf('u-mia', 'member', { budget: { monthlyUsd: 400, alertAt: 0.8, hardStop: false } }),
    memberOf('u-noah', 'member', { budget: { monthlyUsd: 60, alertAt: 0.8, hardStop: true }, tierLimit: capNoah }),
    { id: 'u-lee', username: 'lee', name: 'Lee Invited', email: 'lee@example.com', role: 'member', status: 'invited', mfa: 'not-enrolled', createdAt: iso(now - 2 * DAY_MS), costThisMonthUsd: 0 },
  ]
  const memberHistory = new Map<string, Array<{ ts: string; status: Member['status'] | 'role'; by?: string; detail?: string }>>()
  for (const m of members) memberHistory.set(m.id, [{ ts: m.createdAt, status: m.status === 'invited' ? 'invited' : 'active', by: 'Ada Admin' }])
  const ciLast = lastReq('client:c-ci')
  const clients: ServiceClient[] = [{
    id: 'c-ci', name: 'ci-bot', description: 'Nightly evaluation jobs', status: 'active', createdAt: iso(v1At), costThisMonthUsd: monthCost('client:c-ci'),
    scope: `${PREFIX}/invoke`, ...(ciLast ? { lastUsedAt: ciLast } : {}),
  }]

  const audit: AuditEntry[] = [
    { id: 'a1', ts: iso(v1At), actor: { kind: 'user', key: 'user:u-admin', name: 'Ada Admin' }, action: 'config.activate', target: `config ${V1}`, summary: `Activated ${V1}`, requestId: 'req-a1', result: 'succeeded', after: { version: V1 } },
    { id: 'a2', ts: iso(v1At + 3600_000), actor: { kind: 'user', key: 'user:u-admin', name: 'Ada Admin' }, action: 'member.invite', target: 'mia@example.com', summary: 'Invited Mia Member (member)', requestId: 'req-a2', result: 'succeeded' },
    { id: 'a3', ts: iso(v1At + 3700_000), actor: { kind: 'user', key: 'user:u-admin', name: 'Ada Admin' }, action: 'member.invite', target: 'noah@example.com', summary: 'Invited Noah Member (member)', requestId: 'req-a3', result: 'succeeded' },
    { id: 'a4', ts: iso(v1At + 7200_000), actor: { kind: 'user', key: 'user:u-admin', name: 'Ada Admin' }, action: 'client.create', target: 'ci-bot', summary: 'Created service client ci-bot', requestId: 'req-a4', result: 'succeeded' },
    { id: 'a5', ts: iso(v2At), actor: { kind: 'user', key: 'user:u-admin', name: 'Ada Admin' }, action: 'config.activate', target: `config ${V2}`, summary: `Activated ${V2} (mode auto)`, requestId: 'req-a5', result: 'succeeded', before: { mode: 'observe' }, after: { mode: 'auto' } },
    { id: 'a6', ts: iso(now - 2 * DAY_MS), actor: { kind: 'user', key: 'user:u-admin', name: 'Ada Admin' }, action: 'member.invite', target: 'lee@example.com', summary: 'Invited Lee Invited (member)', requestId: 'req-a6', result: 'succeeded' },
  ]

  const universe = [...new Set(Object.values(pool).flatMap((p) => p.models.map((m) => m.model)).concat(['global.anthropic.claude-sonnet-5', 'global.openai.gpt-6-sol', 'global.openai.gpt-5.6-luna']))]
  const gateway: GatewayInfo = {
    url: `https://${PREFIX}-gw-0123abcd.gateway.bedrock-agentcore.${REGION}.amazonaws.com`, id: `${PREFIX}-gw-0123abcd`, status: 'READY', updatedAt: iso(v1At),
    authorizer: { discoveryUrl: `https://cognito-idp.${REGION}.amazonaws.com/${REGION}_MockPool/.well-known/openid-configuration`, allowedScopes: [`${PREFIX}/invoke`] },
    targets: [
      { name: 'router', role: 'router', detail: 'Private REST API (AWS_IAM, SigV4 by the gateway role)' },
      { name: 'fallback', role: 'fallback', detail: 'Bedrock models served directly by the gateway', models: ['global.anthropic.claude-sonnet-5-5', 'global.openai.gpt-6.1-sol'] },
    ],
    rules: [{ priority: 1000, match: 'any model (catch-all)', target: 'router' }, { priority: 0, match: 'router 5xx or unreachable', target: 'fallback' }],
    fallbackChain: ['router', 'fallback'],
    forwardedHeaders: ['anthropic-version', 'anthropic-beta', 'openai-beta', 'content-type', 'x-router-session', 'x-router-parent-session', 'x-router-hint', 'x-router-agent', 'x-router-task', 'x-api-key'],
    cdkParameters: { url: 'stack output GatewayUrl', authorizer: 'gatewayScopes', targets: 'routerTarget / fallbackModels', rules: 'gatewayRules', forwardedHeaders: 'forwardedHeaders' },
  }

  const principalEntries = new Map<PrincipalKey, PrincipalEntry>()
  for (const m of members) principalEntries.set(`user:${m.id}`, { group: m.role, ...(m.tierLimit ? { cap: m.tierLimit } : {}) })
  for (const c of clients) principalEntries.set(`client:${c.id}`, { group: 'service', ...(c.tierLimit ? { cap: c.tierLimit } : {}) })

  return {
    now, catalog, records, principals, members, memberHistory, clients, versions, principalEntries,
    configDelivery: { state: 'delivered', at: iso(v2At + 2_000) }, identityDelivery: { state: 'delivered', at: iso(now - 3600_000) }, identityKeys: KEY_STATES.loaded,
    baked, bakedReadable: effectiveMode !== 'unknown', reportedMismatch: false,
    router: { status: 'active', reportedVersion: versions.at(-1)!.version, since: iso(v2At + 25_000) },
    universe, packs, audit, settings: { retentionDays: 90, defaultBaseline: 'static' }, defaultBudget: { monthlyUsd: 200, alertAt: 0.8, hardStop: false }, gateway,
  }
}

/** 0d warmAdj: move up to the warm prefix from writes (longest TTL first), then uncached, to reads. */
export function warmAdj(u: NormalizedUsage, w: number): NormalizedUsage {
  const total = Math.max(0, Math.min(w, u.promptTokens) - u.cacheReadTokens)
  let k = total
  const writes = { ...u.cacheWriteTokens }
  for (const ttl of ['12h', '1h', '30m', '5m'] as const) {
    const v = writes[ttl] ?? 0
    const take = Math.min(v, k)
    if (take > 0) { writes[ttl] = v - take; k -= take }
  }
  const fromUncached = Math.min(u.uncachedInputTokens, k)
  k -= fromUncached
  return { ...u, cacheWriteTokens: writes, uncachedInputTokens: u.uncachedInputTokens - fromUncached, cacheReadTokens: u.cacheReadTokens + (total - k) }
}
