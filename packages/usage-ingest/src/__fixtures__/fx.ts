// 0d's worked fixtures (research/0d-savings-hotswap.md §1.9): catalog fx-1, policies fx-auto-1 / fx-observe-1, and
// the log lines F1–F5 exactly as written there (F5 includes f5b, the 0.3c unmetered line).
import { validatePolicy, type Policy } from '@auto-router/core'
import { validateCatalog, type ModelPrice, type PriceCatalog } from '@auto-router/pricing'
import type { RouterLine } from '../types.ts'

const model = (modelId: string, tier: ModelPrice['tier'], input: number, output: number, read: number, w5: number, w1: number): ModelPrice => ({
  modelId, family: 'claude', tier, dialects: ['anthropic-messages'], endpointScope: 'global', contextWindow: 1_000_000,
  price: { input, output, cacheRead: read, cacheWrite: { '5m': w5, '1h': w1 } },
  cache: { mode: 'explicit', minTokens: 512, ttls: ['5m', '1h'], defaultTtl: '5m' },
})

export const fxCatalog: PriceCatalog = validateCatalog({
  version: 'fx-1', asOf: '2026-11-08', source: 'fixture', region: 'fx',
  models: [
    model('fx.frontier', 'frontier', 5, 25, 0.5, 6.25, 10),
    model('fx.standard', 'standard', 2, 10, 0.2, 2.5, 4),
    model('fx.standard-geo', 'standard', 2, 10, 0.2, 2.5, 4),
    model('fx.fast', 'fast', 0.5, 2.5, 0.05, 0.625, 1),
  ],
})

const pool = { defaultTier: 'standard' as const, models: [{ model: 'fx.frontier' }, { model: 'fx.standard', failover: ['fx.standard-geo'] }, { model: 'fx.fast' }] }
export const fxAuto: Policy = validatePolicy({
  schemaVersion: 1, version: 'fx-auto-1', mode: 'auto', userTurn: 'cost-gated',
  pools: { 'anthropic-messages': pool }, observeDefaults: { 'anthropic-messages': 'fx.standard' },
})
export const fxObserve: Policy = validatePolicy({
  schemaVersion: 1, version: 'fx-observe-1', mode: 'observe', userTurn: 'retain',
  pools: { 'anthropic-messages': pool }, observeDefaults: { 'anthropic-messages': 'fx.standard' },
})
export const fxPolicies: Record<string, Policy> = { 'fx-auto-1': fxAuto, 'fx-observe-1': fxObserve }

const raw = String.raw
const L = (s: string): RouterLine => JSON.parse(s) as RouterLine

export const F1 = [L(raw`{"ts":"2026-11-08T01:00:00.000Z","reqId":"f1","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L1","catalogVersion":"fx-1","decision":{"action":"initialize","point":"session-start","mode":"auto","model":"fx.fast","reason":"session-start: tier=fast via rule:r1 → fx.fast","policyVersion":"fx-auto-1"},"servedModel":"fx.fast","usage":{"uncachedInputTokens":500,"cacheReadTokens":0,"cacheWriteTokens":{"5m":19500},"outputTokens":1000,"promptTokens":20000},"costUsd":{"input":0.00025,"cacheRead":0,"cacheWrite":0.0121875,"output":0.0025,"total":0.0149375,"tier":"base"}}`)]

export const F2 = [
  L(raw`{"ts":"2026-11-08T02:00:00.000Z","reqId":"f2a","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L2","catalogVersion":"fx-1","decision":{"action":"switch","point":"user-turn","mode":"auto","model":"fx.fast","reason":"downgrade: standard→fast fx.standard → fx.fast saving=$0.0500 need=$0.0200 H=15","policyVersion":"fx-auto-1","estimate":{"stayUsd":0.09,"switchUsd":0.04,"horizonCalls":15}},"servedModel":"fx.fast","switchedFrom":{"model":"fx.standard","warmTokens":40000},"usage":{"uncachedInputTokens":500,"cacheReadTokens":0,"cacheWriteTokens":{"5m":41500},"outputTokens":800,"promptTokens":42000},"costUsd":{"input":0.00025,"cacheRead":0,"cacheWrite":0.0259375,"output":0.002,"total":0.0281875,"tier":"base"}}`),
  L(raw`{"ts":"2026-11-08T02:00:20.000Z","reqId":"f2b","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L2","catalogVersion":"fx-1","decision":{"action":"retain","point":"hard-lock-tool-loop","mode":"auto","model":"fx.fast","reason":"hard-lock: tool loop","policyVersion":"fx-auto-1"},"servedModel":"fx.fast","usage":{"uncachedInputTokens":300,"cacheReadTokens":41500,"cacheWriteTokens":{"5m":1200},"outputTokens":600,"promptTokens":43000},"costUsd":{"input":0.00015,"cacheRead":0.002075,"cacheWrite":0.00075,"output":0.0015,"total":0.004475,"tier":"base"}}`),
]

export const F3 = [
  L(raw`{"ts":"2026-11-08T03:00:00.000Z","reqId":"f3a","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L3","catalogVersion":"fx-1","decision":{"action":"initialize","point":"session-start","mode":"auto","model":"fx.fast","reason":"session-start: tier=fast via assessor(0.91) → fx.fast","policyVersion":"fx-auto-1"},"servedModel":"fx.fast","assessor":{"id":"assessor/fx","mode":"auto","autoRules":"pack","status":"ok","tier":"fast","confidence":0.91,"latencyMs":900,"costUsd":0.0004,"applied":true},"usage":{"uncachedInputTokens":300,"cacheReadTokens":0,"cacheWriteTokens":{},"outputTokens":200,"promptTokens":300},"costUsd":{"input":0.00015,"cacheRead":0,"cacheWrite":0,"output":0.0005,"total":0.00065,"tier":"base"}}`),
  L(raw`{"ts":"2026-11-08T03:05:00.000Z","reqId":"f3b","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L3b","catalogVersion":"fx-1","decision":{"action":"switch","point":"failover","mode":"auto","model":"fx.standard-geo","reason":"failover: profile fx.standard → fx.standard-geo after 429","policyVersion":"fx-auto-1"},"servedModel":"fx.standard-geo","switchedFrom":{"model":"fx.standard","warmTokens":30000},"usage":{"uncachedInputTokens":200,"cacheReadTokens":0,"cacheWriteTokens":{"5m":30800},"outputTokens":500,"promptTokens":31000},"costUsd":{"input":0.0004,"cacheRead":0,"cacheWrite":0.077,"output":0.005,"total":0.0824,"tier":"base"}}`),
]

export const F4 = [
  L(raw`{"ts":"2026-11-08T04:00:00.000Z","reqId":"f4a","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L4","catalogVersion":"fx-1","decision":{"action":"initialize","point":"session-start","mode":"observe","model":"fx.standard","reason":"observe-default: session-start: tier=fast via rule:r1 → fx.fast","policyVersion":"fx-observe-1","wouldChoose":"fx.fast","projected":{"model":"fx.fast","switch":false}},"servedModel":"fx.standard","usage":{"uncachedInputTokens":500,"cacheReadTokens":0,"cacheWriteTokens":{"5m":19500},"outputTokens":1000,"promptTokens":20000},"costUsd":{"input":0.001,"cacheRead":0,"cacheWrite":0.04875,"output":0.01,"total":0.05975,"tier":"base"}}`),
  L(raw`{"ts":"2026-11-08T04:00:15.000Z","reqId":"f4b","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L4","catalogVersion":"fx-1","decision":{"action":"retain","point":"hard-lock-tool-loop","mode":"observe","model":"fx.standard","reason":"observe-default: hard-lock: tool loop","policyVersion":"fx-observe-1","wouldChoose":"fx.standard","projected":{"model":"fx.fast","switch":false}},"servedModel":"fx.standard","usage":{"uncachedInputTokens":300,"cacheReadTokens":19500,"cacheWriteTokens":{"5m":1200},"outputTokens":600,"promptTokens":21000},"costUsd":{"input":0.0006,"cacheRead":0.0039,"cacheWrite":0.003,"output":0.006,"total":0.0135,"tier":"base"}}`),
  L(raw`{"ts":"2026-11-08T04:20:00.000Z","reqId":"f4c","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L4","catalogVersion":"fx-1","decision":{"action":"retain","point":"compaction","mode":"observe","model":"fx.standard","reason":"observe-default: compaction:shrink: tier=standard via default → fx.standard","policyVersion":"fx-observe-1","wouldChoose":"fx.standard","projected":{"model":"fx.standard","switch":true}},"servedModel":"fx.standard","usage":{"uncachedInputTokens":200,"cacheReadTokens":4000,"cacheWriteTokens":{"5m":6000},"outputTokens":2000,"promptTokens":10200},"costUsd":{"input":0.0004,"cacheRead":0.0008,"cacheWrite":0.015,"output":0.02,"total":0.0362,"tier":"base"}}`),
]

export const F5 = [
  L(raw`{"ts":"2026-11-08T05:00:00.000Z","reqId":"f5a","kind":"model","status":200,"dialect":"anthropic-messages","requested":"fx.frontier","lineage":"L5","catalogVersion":"fx-1","decision":{"action":"pin","point":"pinned","mode":"auto","model":"fx.frontier","reason":"pin: concrete model fx.frontier","policyVersion":"fx-auto-1"},"servedModel":"fx.frontier","usage":{"uncachedInputTokens":1000,"cacheReadTokens":0,"cacheWriteTokens":{},"outputTokens":100,"promptTokens":1000},"costUsd":{"input":0.005,"cacheRead":0,"cacheWrite":0,"output":0.0025,"total":0.0075,"tier":"base"}}`),
  L(raw`{"ts":"2026-11-08T05:00:01.000Z","reqId":"f5b","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L5b","catalogVersion":"fx-1","decision":{"action":"retain","point":"hard-lock-tool-loop","mode":"auto","model":"fx.standard","reason":"hard-lock: tool loop","policyVersion":"fx-auto-1"},"servedModel":"fx.standard","usageMissing":true,"costBoundUsd":0.05}`),
  L(raw`{"ts":"2026-11-08T05:00:02.000Z","reqId":"f5c","kind":"error","status":503,"dialect":"anthropic-messages","requested":"auto","error":"NoEligibleModelError","reason":"decide-failed"}`),
  L(raw`{"ts":"2026-11-08T05:00:03.000Z","reqId":"f5d","kind":"model","status":200,"dialect":"anthropic-messages","requested":"auto","lineage":"L5d","catalogVersion":"fx-0","decision":{"action":"retain","point":"hard-lock-tool-loop","mode":"auto","model":"fx.fast","reason":"hard-lock: tool loop","policyVersion":"fx-auto-1"},"servedModel":"fx.fast","usage":{"uncachedInputTokens":100,"cacheReadTokens":0,"cacheWriteTokens":{},"outputTokens":10,"promptTokens":100},"costUsd":{"input":0.00005,"cacheRead":0,"cacheWrite":0,"output":0.000025,"total":0.000075,"tier":"base"}}`),
]

export const ALL = [...F1, ...F2, ...F3, ...F4, ...F5]
