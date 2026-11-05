// Eval harness (design §10.2): runs items through createAssessor with a budget ledger, bounded concurrency and
// scrubbed per-item results. The transport is injected (live SigV4 in the CLI, fakeTransport in tests).
import type { PriceCatalog } from '@auto-router/pricing'
import { findModel } from '@auto-router/pricing'
import { createAssessor, DEFAULT_MAX_OUTPUT_TOKENS, type AssessorCallInfo, type AssessorConfig } from '../assessor.ts'
import type { Tier } from '../contract.ts'
import { mapTier } from '../map.ts'
import { loadPack, renderPrompt, type Pack } from '../pack.ts'
import { outputSchema } from '../schema.ts'
import type { Assessment } from '../validate.ts'
import type { Transport } from '../transport.ts'
import type { EvalItem } from './datasets.ts'
import { scrub, type Ledger } from './scrub.ts'

export interface EvalResult {
  itemId: string
  dataset: EvalItem['dataset']
  category: string
  gold: Tier
  model: string
  variant: string
  status: 'ok' | 'unavailable'
  reason?: string
  skipped?: string
  proposedTier?: Tier
  /** Tier the mapping gives with the confidence gate disabled (threshold 0), for the offline threshold sweep. */
  tierAt0?: Tier
  outcome?: string
  basis?: string[]
  matched?: string[]
  facts?: Record<string, unknown>
  confidence?: number
  latencyMs: number
  called: boolean
  inputTokens?: number
  cachedTokens?: number
  outputTokens?: number
  costUsd?: number
  packVersion: string
}

export interface RunOptions {
  /** Prompt pack; default the shipped default pack (v1). */
  pack?: Pack
  items: EvalItem[]
  model: string
  variant?: string
  transport: Transport
  catalog: PriceCatalog
  ledger: Ledger
  concurrency?: number
  timeoutMs?: number
  config?: Partial<AssessorConfig>
  onResult?: (r: EvalResult, done: number, total: number) => void
}

export interface RunSummary { results: EvalResult[]; stoppedByBudget: number }

/** Framing tokens per request (roles, tool wrapper, schema name) on top of the counted text; generous. */
const REQUEST_OVERHEAD_BYTES = 1024

/**
 * Upper bound on the cost of one call, so the ledger cannot be overrun: every prompt token is billed at the highest
 * input-side rate of the model (base input or any cache-write TTL, long-context tier included; Haiku writes cost 1.25×
 * input), the prompt has at most one token per UTF-8 byte (byte-level BPE), and the full output cap is used.
 */
export function worstCaseUsd(catalog: PriceCatalog, model: string, promptBytes: number, maxOutputTokens: number): number {
  const price = findModel(catalog, model)
  if (!price) throw new Error(`no price for ${model}`)
  const tiers = [price.price, ...(price.longContext ? [price.longContext.price] : [])]
  const inRate = Math.max(...tiers.flatMap((p) => [p.input, ...Object.values(p.cacheWrite).filter((v): v is number => typeof v === 'number')]))
  const outRate = Math.max(...tiers.map((p) => p.output))
  return (Math.ceil(promptBytes) * inRate + maxOutputTokens * outRate) / 1e6
}

/** UTF-8 bytes of everything the request carries as prompt: system, card, output schema and framing. */
export function promptBytesOf(system: string, user: string, schema: unknown): number {
  return Buffer.byteLength(system, 'utf8') + Buffer.byteLength(user, 'utf8') + Buffer.byteLength(JSON.stringify(schema), 'utf8') + REQUEST_OVERHEAD_BYTES
}

export async function runEval(o: RunOptions): Promise<RunSummary> {
  const pack = o.pack ?? loadPack()
  const maxOut = o.config?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const schema = outputSchema(pack.rules.filter((r) => r.enabled))
  const results: EvalResult[] = new Array(o.items.length)
  let next = 0
  let done = 0
  let stoppedByBudget = 0

  const worker = async (): Promise<void> => {
    while (next < o.items.length) {
      const i = next++
      const item = o.items[i] as EvalItem
      const prompt = renderPrompt(pack, item.card)
      const est = worstCaseUsd(o.catalog, o.model, promptBytesOf(prompt.system, prompt.user, schema), maxOut)
      if (!o.ledger.reserve(est)) { stoppedByBudget++; continue }
      let info: AssessorCallInfo | undefined
      const assessor = createAssessor({
        ...o.config,
        model: o.model,
        transport: o.transport,
        catalog: o.catalog,
        pack,
        timeoutMs: o.timeoutMs ?? 10_000,
        onCall: (x) => { info = x },
      })
      const res = await assessor.assess(item.card, new AbortController().signal)
      o.ledger.settle(est, info?.called ? info.costUsd : 0)
      const audit = res.status === 'ok' ? res.audit : {}
      const usage = info?.usage
      const at0 = res.status === 'ok' && Array.isArray(audit.ruleAssessments) && audit.facts
        ? mapTier({ rule_assessments: audit.ruleAssessments, task_facts: audit.facts, confidence: res.confidence, reason: 'x' } as Assessment, pack.rules, { threshold: 0 }).proposedTier
        : undefined
      const r: EvalResult = scrub({
        itemId: item.id, dataset: item.dataset, category: item.category, gold: item.gold, model: o.model, variant: o.variant ?? 'default',
        status: res.status,
        ...(res.status === 'unavailable' ? { reason: res.reason } : {}),
        ...(typeof audit.skipped === 'string' ? { skipped: audit.skipped } : {}),
        ...(typeof audit.proposedTier === 'string' ? { proposedTier: audit.proposedTier as Tier } : {}),
        ...(at0 ? { tierAt0: at0 } : {}),
        ...(typeof audit.outcome === 'string' ? { outcome: audit.outcome } : {}),
        ...(Array.isArray(audit.basis) ? { basis: audit.basis as string[] } : {}),
        ...(Array.isArray(audit.matched) ? { matched: audit.matched as string[] } : {}),
        ...(audit.facts && typeof audit.facts === 'object' ? { facts: audit.facts as Record<string, unknown> } : {}),
        ...(res.status === 'ok' ? { confidence: res.confidence } : {}),
        latencyMs: res.latencyMs,
        called: info?.called ?? false,
        ...(usage ? { inputTokens: usage.promptTokens, cachedTokens: usage.cacheReadTokens, outputTokens: usage.outputTokens } : {}),
        ...(info?.costUsd !== undefined ? { costUsd: info.costUsd } : {}),
        packVersion: assessor.packVersion,
      })
      results[i] = r
      done++
      o.onResult?.(r, done, o.items.length)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 4) }, worker))
  return { results: results.filter((r): r is EvalResult => r !== undefined), stoppedByBudget }
}
