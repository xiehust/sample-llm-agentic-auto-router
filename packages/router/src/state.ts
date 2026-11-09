// Router state line (admin console: identity require gate, "reported" settings; 0d contract in
// research/0d-effective-config.md §7). A `kind:"config"` line with source 'state' and outcome 'active', written right
// after boot, after every change of the config document, the principal file or an identity object, and every
// STATE_INTERVAL_MS, so the console always has a fresh line per running task (other config lines appear only on
// changes and can predate the log subscription). Codes, versions and counts only: never keys, ids or values.
import type { IdentityState } from './identity.ts'
import type { RuntimeRef } from './runtime.ts'

/** Heartbeat period. Consumers treat a task as fresh for 3 periods (15 min). */
export const STATE_INTERVAL_MS = 300_000

export interface IdentityKeysView {
  /** The identity gate is configured (ROUTER_IDENTITY_*); false: no keys are expected. */
  configured: boolean
  /** At least one signing key is loaded (the verifier can verify; require would not answer every request 401). */
  loaded: boolean
  /** Number of signing keys loaded. */
  kids: number
  /** Versions (ETag-derived) of the identity objects in force, when loaded. */
  versions: { jwks?: string; blocks?: string; budgetBlocks?: string }
}

export function identityKeysView(state: IdentityState | undefined): IdentityKeysView {
  if (!state) return { configured: false, loaded: false, kids: 0, versions: {} }
  const versions: IdentityKeysView['versions'] = {}
  for (const o of ['jwks', 'blocks', 'budgetBlocks'] as const) { const v = state.version(o); if (v !== undefined) versions[o] = v }
  return { configured: true, loaded: state.hasKeys, kids: state.keyCount, versions }
}

export interface StateReporter {
  /** Writes one state line now. */
  emit(): void
  start(): void
  stop(): void
}

export function createStateReporter(o: {
  runtime: RuntimeRef
  identity?: IdentityState
  intervalMs?: number
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void }
}): StateReporter {
  const intervalMs = o.intervalMs ?? STATE_INTERVAL_MS
  const timers = o.timers ?? { set: (fn, ms) => setInterval(fn, ms).unref(), clear: (t) => clearInterval(t as NodeJS.Timeout) }
  let timer: unknown
  const emit = (): void => o.runtime.log('state', 'active', { identityKeys: identityKeysView(o.identity) })
  return {
    emit,
    start() { if (timer === undefined) timer = timers.set(emit, intervalMs) },
    stop() { if (timer !== undefined) { timers.clear(timer); timer = undefined } },
  }
}
