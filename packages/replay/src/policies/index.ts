import { type Policy, policyPresets, type PriceCatalog } from '../deps.ts'
import { alwaysTier, classifier, hintBlind, intentBlind, recorded, stickySession } from './basic.ts'
import { corePolicy } from './core.ts'
import type { ReplayPolicy } from './types.ts'

/** core-cost-subfast needs policyPresets.costModeledSubagentFast (router-core item 6); listed only once it exists. */
const subagentFastPreset = (): Policy | undefined => (policyPresets as Record<string, Policy | undefined>).costModeledSubagentFast

export const POLICY_NAMES = [
  'recorded', 'always-frontier', 'always-cheap', 'classifier', 'intent-blind', 'hint-blind', 'sticky-session', 'core-boundary', 'core-cost',
  ...(subagentFastPreset() ? ['core-cost-subfast'] : []),
]

/** costModeled minus the count gates: every user-turn downgrade is judged by the cost gate alone. */
export const withoutCountGates = (p: Policy): Policy => ({
  ...p,
  hysteresis: { ...p.hysteresis, minTurnsBeforeSwitch: 0, maxSwitchesPerLineage: Number.MAX_SAFE_INTEGER },
})

export interface MakePolicyOpts {
  catalog: PriceCatalog
  hints: 'none' | 'cooperative'
  /** applied to core presets before createEngine (e.g. write TTL overrides in a sweep) */
  corePolicy?: (p: Policy) => Policy
}

export function makePolicy(name: string, o: MakePolicyOpts): ReplayPolicy {
  const tx = o.corePolicy ?? ((p: Policy) => p)
  switch (name) {
    case 'recorded': return recorded
    case 'always-frontier': return alwaysTier(name, 'frontier')
    case 'always-cheap': return alwaysTier(name, 'fast')
    case 'classifier': return classifier
    case 'sticky-session': return stickySession()
    case 'core-boundary': return corePolicy({ name, policy: tx(policyPresets.boundaryGated), catalog: o.catalog, hints: o.hints })
    case 'core-cost': return corePolicy({ name, policy: tx(policyPresets.costModeled), catalog: o.catalog, hints: o.hints })
    // Sensitivity variant (not in POLICY_NAMES): costModeled with the count gates (minTurnsBeforeSwitch,
    // maxSwitchesPerLineage) off, so only the cost gate holds back downgrades.
    case 'core-cost-nocount': return corePolicy({ name, policy: tx(withoutCountGates(policyPresets.costModeled)), catalog: o.catalog, hints: o.hints })
    case 'intent-blind': return intentBlind()
    case 'hint-blind': return hintBlind
    case 'core-cost-subfast': {
      const policy = subagentFastPreset()
      if (!policy) throw new Error('core-cost-subfast: @auto-router/core does not export policyPresets.costModeledSubagentFast yet')
      return corePolicy({ name, policy: tx(policy), catalog: o.catalog, hints: o.hints })
    }
    default: throw new Error(`unknown policy '${name}' (known: ${POLICY_NAMES.join(', ')}, core-cost-nocount)`)
  }
}

export const allPolicies = (names: string[], o: MakePolicyOpts): ReplayPolicy[] => names.map((n) => makePolicy(n, o))
export * from './basic.ts'
export * from './core.ts'
export type * from './types.ts'
