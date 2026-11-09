// One Lambda event: parse → figures → records + rollups in chunks of ≤ 20 requests, one transaction per chunk
// (a3 §3 idempotency: a re-delivered line hits its record's attribute_not_exists condition, is dropped, and the
// rest of the chunk is retried, so nothing is counted twice) → budget evaluation.
import type { PriceCatalog } from '@auto-router/pricing'
import { evaluateBudgets, type BudgetDeps, type BudgetReport } from './budgets.ts'
import { parseEvents, type DecodedPayload } from './parse.ts'
import { buildConfig, buildRequest, buildState } from './records.ts'
import { lineFigures } from './savings.ts'
import type { ConfigLine, PolicySource, TxAdd, TxPut, UsageStore } from './types.ts'

export const CHUNK = 20
const MAX_ATTEMPTS = 8

export interface IngestDeps {
  catalog: PriceCatalog
  policies: PolicySource
  store: UsageStore
  retentionDays: number
  now: () => number
  budgets?: Omit<BudgetDeps, 'store' | 'now'>
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export interface IngestReport {
  events: number
  requests: number
  configs: number
  written: number
  duplicates: number
  retries: number
  skipped: Record<string, number>
  policyUnknown: number
  /** The batch's latest state line: stored as the task's C#state, or older than the stored one. */
  state?: 'written' | 'stale'
  budgets?: BudgetReport
}

interface Entry { reqId: string; put: TxPut; adds: TxAdd[]; principal?: string }

/** Sums the deltas of every add with the same key (an item may appear only once per transaction). */
export function mergeAdds(adds: TxAdd[]): TxAdd[] {
  const byKey = new Map<string, TxAdd>()
  for (const a of adds) {
    const k = `${a.key.pk}|${a.key.sk}`
    const cur = byKey.get(k)
    if (!cur) {
      byKey.set(k, { key: a.key, add: { ...a.add }, ttl: a.ttl, ...(a.set ? { set: { ...a.set } } : {}) })
      continue
    }
    for (const [n, v] of Object.entries(a.add)) cur.add[n] = (cur.add[n] ?? 0) + v
    cur.ttl = Math.max(cur.ttl, a.ttl)
    if (a.set) cur.set = { ...cur.set, ...a.set }
  }
  return [...byKey.values()].filter((a) => Object.keys(a.add).length > 0)
}

export async function ingest(payload: DecodedPayload, deps: IngestDeps): Promise<IngestReport> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = deps.random ?? Math.random
  const parsed = parseEvents(payload)
  const report: IngestReport = { events: payload.logEvents.length, requests: parsed.requests.length, configs: parsed.configs.length,
    written: 0, duplicates: 0, retries: 0, skipped: parsed.skipped, policyUnknown: 0 }
  const entries: Entry[] = []
  const seen = new Set<string>()
  for (const line of parsed.requests) {
    if (seen.has(line.reqId)) {
      report.duplicates += 1 // the same line twice in one delivery
      continue
    }
    seen.add(line.reqId)
    const resolved = line.decision ? await deps.policies.get(line.configVersion, line.decision.policyVersion) : undefined
    if (line.decision && line.decision.action !== 'pin' && !resolved) report.policyUnknown += 1
    const f = lineFigures(line, resolved?.policy, deps.catalog)
    const b = buildRequest(line, f, resolved, deps.catalog, deps.retentionDays)
    entries.push({ reqId: line.reqId, put: b.put, adds: b.adds, principal: b.principal })
  }
  const task = payload.logStream.split('/').pop() ?? payload.logStream
  // State lines (source 'state', 0d effective-config §7) keep only the task's latest as C#state; every other config
  // line is a C#config item.
  let state: ConfigLine | undefined
  for (const c of parsed.configs) {
    if (c.source === 'state') {
      if (!state || Date.parse(c.ts) > Date.parse(state.ts)) state = c
      continue
    }
    const put = buildConfig(c, task, deps.retentionDays)
    entries.push({ reqId: `config:${String(put.item.sk)}`, put, adds: [] })
  }

  const touched = new Set<string>()
  for (let i = 0; i < entries.length; i += CHUNK) {
    let chunk = entries.slice(i, i + CHUNK)
    for (let attempt = 1; ; attempt++) {
      if (chunk.length === 0) break
      const outcome = await deps.store.transact(chunk.map((e) => e.put), mergeAdds(chunk.flatMap((e) => e.adds)))
      if (outcome.ok) {
        report.written += chunk.length
        for (const e of chunk) if (e.principal && e.adds.length) touched.add(e.principal)
        break
      }
      if (attempt >= MAX_ATTEMPTS) throw new Error(`usage transaction failed after ${attempt} attempts`)
      report.retries += 1
      if (outcome.duplicates.length > 0) {
        const dup = new Set(outcome.duplicates)
        report.duplicates += dup.size
        chunk = chunk.filter((_, j) => !dup.has(j))
        if (!outcome.retryable) continue
      }
      await sleep(Math.min(2000, 50 * 2 ** attempt) * (0.5 + random()))
    }
  }

  if (state) report.state = await deps.store.putLatest(buildState(state, task))

  if (deps.budgets) {
    report.budgets = await evaluateBudgets(touched, { ...deps.budgets, store: deps.store, now: deps.now })
  }
  return report
}
