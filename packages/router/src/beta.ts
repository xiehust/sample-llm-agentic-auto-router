// anthropic-beta veto (design §2.7, D8; revised 2026-11-04 after review): never move a session onto a model that
// is KNOWN to reject one of the request's betas. Unknown betas are allowed (Bedrock validates them).
// - observe mode: the served model never changes; only wouldChoose is annotated;
// - auto mode: switch/initialize may only move to a same-or-higher tier model that accepts the betas
//   (the session's current model first, then pool order); if there is none, the decision is kept.
import type { Decision, Tier } from '@auto-router/core'
import { BETA_REJECTS } from './beta-compat.ts'

export type BetaTable = Readonly<Record<string, readonly string[]>>
export const DEFAULT_BETA_TABLE: BetaTable = BETA_REJECTS

const TIER_RANK: Record<Tier, number> = { fast: 0, standard: 1, frontier: 2 }
const globRe = (g: string): RegExp => new RegExp(`^${g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)

export function parseBetas(header: string | undefined): string[] {
  return header ? header.split(',').map((s) => s.trim()).filter(Boolean) : []
}

/** Model globs that reject one beta value: exact key first, then the longest matching prefix glob. */
function rejectGlobs(t: BetaTable, beta: string): readonly string[] {
  if (t[beta]) return t[beta]
  let best: string | undefined
  for (const k of Object.keys(t)) if (k.endsWith('*') && beta.startsWith(k.slice(0, -1)) && (!best || k.length > best.length)) best = k
  return best ? (t[best] ?? []) : []
}

/** The first beta `model` is known to reject, or undefined when none is. */
export function rejectedBeta(t: BetaTable, model: string, betas: readonly string[]): string | undefined {
  return betas.find((b) => rejectGlobs(t, b).some((g) => globRe(g).test(model)))
}

export interface PoolModel { model: string; tier: Tier }
export interface VetoContext { current?: string; pool: readonly PoolModel[] }

function safeTarget(t: BetaTable, target: string, betas: readonly string[], ctx: VetoContext): string | undefined {
  const tierOf = (m: string) => ctx.pool.find((p) => p.model === m)?.tier
  const floor = tierOf(target)
  if (floor === undefined) return undefined
  const ok = (m: string) => { const tr = tierOf(m); return tr !== undefined && TIER_RANK[tr] >= TIER_RANK[floor] && !rejectedBeta(t, m, betas) }
  if (ctx.current && ctx.current !== target && ok(ctx.current)) return ctx.current
  const ordered = [...ctx.pool].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]) // same tier first, stable pool order
  return ordered.find((p) => p.model !== target && ok(p.model))?.model
}

export function betaVeto(decision: Decision, betas: string[], ctx: VetoContext, t: BetaTable = DEFAULT_BETA_TABLE): { decision: Decision; vetoed?: string } {
  if (!betas.length) return { decision }
  if (decision.mode === 'observe') {
    const would = decision.wouldChoose
    const beta = would ? rejectedBeta(t, would, betas) : undefined
    if (!would || !beta) return { decision }
    const alt = safeTarget(t, would, betas, ctx)
    return { decision: { ...decision, ...(alt ? { wouldChoose: alt } : {}), reason: `${decision.reason} [would-choose beta-incompatible: ${beta}]` }, vetoed: beta }
  }
  if (decision.action !== 'switch' && decision.action !== 'initialize') return { decision }
  const beta = rejectedBeta(t, decision.model, betas)
  if (!beta) return { decision }
  const alt = safeTarget(t, decision.model, betas, ctx)
  if (!alt) return { decision }
  const action = decision.action === 'switch' && alt === ctx.current ? 'retain' : decision.action
  return { decision: { ...decision, action, model: alt, reason: `beta-incompatible: ${beta}` }, vetoed: beta }
}
