// Decision reason parsing (pure; part of `@auto-router/core/policy`). A reason is
// `[<prefix>: ]<code>: <text>; family=<f> est=<n>[; gate-fallback[:current|:cheapest]][; access-cap:<max>:<from>]...`.
// The code and the keys are the contract; the free text is not (consumers must not parse it).
import { TIERS, type Tier } from './policy.ts'

export type ReasonPrefix = 'observe-default' | 'observe-hold'
export interface ParsedReason {
  /** Stable reason code (e.g. 'session-start', 'downgrade', 'hard-lock', 'ineligible', 'pin'). */
  code: string
  /** Observe mode: the alias was served the observe default, or held on the lineage's model (after a config swap). */
  prefix?: ReasonPrefix
  family?: string
  est?: number
  gate?: 'gate-fallback' | 'gate-fallback:current' | 'gate-fallback:cheapest'
  /** The caller's cap kept routing below the tier it would have chosen (design 0.16): the cap's maxTier. */
  accessCap?: Tier
  /** The tier routing would have chosen without the cap (`access-cap:<max>:<from>`; absent in the older 2-part form). */
  accessCapFrom?: Tier
}

const PREFIXES: readonly ReasonPrefix[] = ['observe-default', 'observe-hold']

export function parseReason(reason: string): ParsedReason {
  let r = reason
  let prefix: ReasonPrefix | undefined
  for (const p of PREFIXES) if (r.startsWith(`${p}: `)) { prefix = p; r = r.slice(p.length + 2); break }
  const i = r.indexOf(':')
  const out: ParsedReason = { code: (i < 0 ? r : r.slice(0, i)).trim() }
  if (prefix) out.prefix = prefix
  for (const part of r.split('; ').slice(1)) {
    const m = /^family=(\S+) est=(\d+)/.exec(part)
    if (m) { out.family = m[1] as string; out.est = Number(m[2]); continue }
    if (part === 'gate-fallback' || part === 'gate-fallback:current' || part === 'gate-fallback:cheapest') out.gate = part
    const c = /^access-cap:(\w+)(?::(\w+))?$/.exec(part)
    if (c && (TIERS as readonly string[]).includes(c[1] as string)) {
      out.accessCap = c[1] as Tier
      if (c[2] !== undefined && (TIERS as readonly string[]).includes(c[2])) out.accessCapFrom = c[2] as Tier
    }
  }
  return out
}
