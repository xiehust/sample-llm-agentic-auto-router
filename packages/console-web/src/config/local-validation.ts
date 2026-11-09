// Instant (browser) checks for the policy editor, behind an interface. The server validates authoritatively with
// the router's own validators on Validate and Activate. Once @auto-router/core/policy (C3, 0d) is on this branch,
// `validatePolicy` and `checkPolicyAgainstCatalog` from it replace the shape checks below (browser-safe import graph).

import type { ConfigDocument } from '@auto-router/console-contract'

export interface LocalValidator {
  /** Problems that make the document unusable before any server call (English, shown as router detail). */
  check(doc: unknown): string[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const DIALECTS = ['anthropic-messages', 'openai-chat', 'openai-responses']
const TIERS = ['fast', 'standard', 'frontier']

export const shapeValidator: LocalValidator = {
  check(doc) {
    const out: string[] = []
    if (!isObj(doc)) return ['document: object required']
    if (doc.schemaVersion !== 1) out.push('schemaVersion: 1 required')
    const p = doc.policy
    if (!isObj(p)) return [...out, 'policy: object required']
    if (p.mode !== 'observe' && p.mode !== 'auto') out.push("policy.mode: 'observe' | 'auto'")
    if (!isObj(p.pools) || Object.keys(p.pools).length === 0) out.push('policy.pools: at least one pool')
    else {
      for (const [d, pool] of Object.entries(p.pools)) {
        if (!DIALECTS.includes(d)) { out.push(`policy.pools.${d}: unknown API`); continue }
        if (!isObj(pool)) { out.push(`policy.pools.${d}: object required`); continue }
        if (!TIERS.includes(pool.defaultTier as string)) out.push(`policy.pools.${d}.defaultTier: fast | standard | frontier`)
        if (!Array.isArray(pool.models) || pool.models.length === 0) out.push(`policy.pools.${d}.models: at least one model`)
        else pool.models.forEach((m, i) => { if (!isObj(m) || typeof m.model !== 'string' || !m.model) out.push(`policy.pools.${d}.models[${i}].model: model id required`) })
      }
    }
    if (!isObj(doc.access) || !isObj(doc.access.groups)) out.push('access.groups: object required')
    return out
  },
}

export const parseDocument = (text: string): { doc?: ConfigDocument; error?: string } => {
  try { return { doc: JSON.parse(text) as ConfigDocument } } catch (e) { return { error: (e as Error).message } }
}
