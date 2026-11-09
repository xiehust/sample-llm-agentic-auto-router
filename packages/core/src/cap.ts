// Per-principal access caps (admin console design 0.16). Pure: shared by core (decision constraint), the router
// (pin check) and the console (validation), so it is part of the browser-safe `@auto-router/core/policy` export.
import { TIERS, tierRank, type Tier } from './policy.ts'

/**
 * `maxTier`: highest tier routing may choose for this principal (absent: no limit). `allowPins`: concrete model ids
 * the principal may pin even above `maxTier` (an exception list; pins within `maxTier` never need it).
 */
export interface Cap { maxTier?: Tier; allowPins?: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Validates one cap object; pushes issues prefixed with `at` and returns the cap (undefined when unusable). */
export function validateCap(raw: unknown, at: string, issues: string[]): Cap | undefined {
  if (!isObj(raw)) { issues.push(`${at}: object required`); return undefined }
  const out: Cap = {}
  let ok = true
  for (const k of Object.keys(raw)) if (k !== 'maxTier' && k !== 'allowPins') { issues.push(`${at}.${k}: unknown field (maxTier | allowPins)`); ok = false }
  if (raw.maxTier !== undefined) {
    if (typeof raw.maxTier === 'string' && (TIERS as readonly string[]).includes(raw.maxTier)) out.maxTier = raw.maxTier as Tier
    else { issues.push(`${at}.maxTier: one of ${TIERS.join('|')}`); ok = false }
  }
  if (raw.allowPins !== undefined) {
    if (Array.isArray(raw.allowPins) && raw.allowPins.every((m) => typeof m === 'string' && m !== '')) out.allowPins = [...new Set(raw.allowPins as string[])]
    else { issues.push(`${at}.allowPins: array of model ids required`); ok = false }
  }
  return ok ? out : undefined
}

/** True when `tier` is within the cap's maxTier (no cap, or no maxTier: always). An unknown tier is outside a set maxTier. */
export function tierWithinCap(cap: Cap | undefined, tier: Tier | undefined): boolean {
  if (cap?.maxTier === undefined) return true
  return tier !== undefined && tierRank(tier) <= tierRank(cap.maxTier)
}

/** Pin check (access semantics, applied immediately): within maxTier, or listed in allowPins. */
export function pinAllowedByCap(cap: Cap | undefined, model: string, tier: Tier | undefined): boolean {
  return tierWithinCap(cap, tier) || (cap?.allowPins?.includes(model) ?? false)
}
