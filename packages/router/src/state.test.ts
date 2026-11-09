// Router state lines (0d-effective-config.md §7): source 'state', outcome 'active', codes/versions/counts only.
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { InMemoryStateStore } from '@auto-router/core'
import { loadCatalog } from '@auto-router/pricing'
import { IdentityState } from './identity.ts'
import { createRuntime } from './runtime.ts'
import { bakedDocument } from './settings.ts'
import { createStateReporter, identityKeysView, STATE_INTERVAL_MS } from './state.ts'
import { testPolicy } from './test-helpers.ts'

const catalog = loadCatalog('ap-northeast-1')
const jwk = (kid: string) => ({ ...generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' })

function setup(identity?: IdentityState) {
  const lines: Record<string, any>[] = []
  const runtime = createRuntime(bakedDocument(testPolicy()), { catalog, store: new InMemoryStateStore(), sink: (l) => lines.push(JSON.parse(l)), buildAssessor: () => ({ ok: true }) })
  const scheduled: Array<{ fn: () => void; ms: number }> = []
  let cleared = 0
  const reporter = createStateReporter({ runtime, ...(identity ? { identity } : {}), timers: { set: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length }, clear: () => { cleared++ } } })
  return { lines, runtime, reporter, scheduled, cleared: () => cleared }
}

describe('router state line', () => {
  it('identity not configured: configured false, no keys', () => {
    expect(identityKeysView(undefined)).toEqual({ configured: false, loaded: false, kids: 0, versions: {} })
  })

  it('reports loaded keys as a count and object versions, never key material', () => {
    const state = new IdentityState()
    expect(identityKeysView(state)).toEqual({ configured: true, loaded: false, kids: 0, versions: {} })
    state.applyJwks({ keys: [jwk('k1'), jwk('k2')] }, 'abc123')
    state.applyBlocks({ schemaVersion: 1, principals: [] }, 'blk1')
    expect(identityKeysView(state)).toEqual({ configured: true, loaded: true, kids: 2, versions: { jwks: 'abc123', blocks: 'blk1' } })
  })

  it('emit writes kind config / source state / outcome active with effective, sources and identityKeys; start schedules every 5 min', () => {
    const state = new IdentityState()
    state.applyJwks({ keys: [jwk('k1')] }, 'v1')
    const { lines, reporter, scheduled, cleared, runtime } = setup(state)
    reporter.emit()
    expect(lines[0]).toMatchObject({
      kind: 'config', source: 'state', outcome: 'active', configVersion: runtime.current().configVersion, principalsVersion: 'none',
      effective: { identityMode: 'off', assessorMode: 'off' }, sources: { policy: 'baked', identity: 'baked', assessor: 'baked', access: 'baked' },
      identityKeys: { configured: true, loaded: true, kids: 1, versions: { jwks: 'v1' } },
    })
    const text = JSON.stringify(lines[0])
    expect(text).not.toMatch(/"(n|e|kty)":/) // no JWK members
    reporter.start()
    reporter.start() // idempotent
    expect(scheduled).toEqual([{ fn: expect.any(Function), ms: STATE_INTERVAL_MS }])
    scheduled[0]?.fn()
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatchObject({ source: 'state', outcome: 'active' })
    reporter.stop()
    reporter.stop()
    expect(cleared()).toBe(1)
  })

  it('without identity: identityKeys configured false (the console then gates require on configuration, not keys)', () => {
    const { lines, reporter } = setup()
    reporter.emit()
    expect(lines[0]?.identityKeys).toEqual({ configured: false, loaded: false, kids: 0, versions: {} })
  })
})
