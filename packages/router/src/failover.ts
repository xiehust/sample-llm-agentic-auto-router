// Same-model, other-profile retry (design §2.6, D9). One retry, only before the first byte reaches the client, and only
// for statuses in policy.failover.profileRotateOn (default 429).
import type { Policy } from '@auto-router/core'
import type { Dialect } from '@auto-router/pricing'

// The retryable set is core's (policy validation of profileRotateOn uses the same one); re-exported for callers.
export { RETRYABLE_STATUS } from '@auto-router/core'

/** The pool entry's `failover` list for `model` (other profiles of the same model, if the region has any); empty when none is configured. */
export function failoverTargets(policy: Policy, dialect: Dialect, model: string): string[] {
  const entry = policy.pools[dialect]?.models.find((m) => m.model === model)
  return entry?.failover ? [...entry.failover] : []
}

/** Jittered 50–150 ms pause before the retry. */
export function jitterMs(random: () => number = Math.random): number {
  return 50 + Math.floor(random() * 100)
}
