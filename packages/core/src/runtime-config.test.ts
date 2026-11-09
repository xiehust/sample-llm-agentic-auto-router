// Admin console C3, core part: config swaps over one store (observe hold, I3), the observe projection, switchedFrom,
// per-request access caps, reason parsing and swap effects (0d research §1.2, §1.6, §2; design 0.3a, 0.16).
import { describe, expect, it } from 'vitest'
import { fixtureCatalog, HAIKU, LUNA, OPUS, SOL, SONNET, SONNET_JP } from './__fixtures__/catalog.ts'
import { assistantText, assistantToolUse, Conversation, FakeProvider, filler, MIN, SEC, T0, testPolicy, toolResult, userText } from './__fixtures__/traces.ts'
import { AccessCapError } from './decide.ts'
import { createEngine } from './engine.ts'
import type { Policy } from './policy.ts'
import { parseReason } from './reason.ts'
import { InMemoryStateStore } from './store-memory.ts'
import { policySwapEffects } from './swap-effects.ts'
import { modelForTier, tierOfPoolModel } from './tiers.ts'
import type { Cap } from './cap.ts'
import type { Decision, Engine, RecordResult } from './types.ts'

const OBS = { 'anthropic-messages': SONNET, 'openai-chat': SOL, 'openai-responses': SOL }
const HDR = { 'x-claude-code-session-id': 'sess-swap' }

/** Engines over one store, one clock and one fake provider: a swap is just using the next engine. */
class World {
  readonly store = new InMemoryStateStore()
  readonly provider = new FakeProvider()
  now = T0
  engine(policy: Policy): Engine {
    return createEngine({ policy, catalog: fixtureCatalog, store: this.store, now: () => this.now })
  }
  async step(e: Engine, body: unknown, o: { at?: number; cap?: Cap; served?: string; status?: number; headers?: Record<string, string> } = {}): Promise<{ d: Decision; r: RecordResult }> {
    if (o.at !== undefined) this.now = o.at
    const s = e.summarize('anthropic-messages', body, o.headers ?? HDR, this.now)
    const d = await e.decide(s, o.cap ? { cap: o.cap } : undefined)
    const served = o.served ?? d.model
    const status = o.status ?? 200
    const r = await e.record(s, d, { servedModel: served, status, ...(status < 400 ? { usage: this.provider.call(served, s) } : {}) })
    return { d, r }
  }
}

const turn = (c: Conversation, i: number): Conversation => c.push(assistantToolUse(`t${i}`, 'ls'), toolResult(`t${i}`, `out ${i}`))

describe('config swap over one store (I3: hard locks hold)', () => {
  it('auto → observe: the auto-chosen model is held through tool loops and user turns, the default applies at the next break point', async () => {
    const w = new World()
    const auto = w.engine(testPolicy())
    const observe = w.engine(testPolicy({ mode: 'observe', observeDefaults: OBS }))
    const conv = new Conversation({ model: 'auto:fast' }).push(userText(`fix it ${filler(3000)}`))
    expect((await w.step(auto, conv.body())).d).toMatchObject({ mode: 'auto', model: HAIKU, point: 'session-start' })
    turn(conv, 1)
    const held = (await w.step(observe, conv.body(), { at: T0 + 5 * SEC })).d
    expect(held).toMatchObject({ mode: 'observe', model: HAIKU, point: 'hard-lock-tool-loop' })
    expect(held.reason).toMatch(/^observe-hold: hard-lock: tool loop/)
    expect(parseReason(held.reason)).toMatchObject({ prefix: 'observe-hold', code: 'hard-lock' })
    conv.push(assistantText('done'), userText('now the docs'))
    expect((await w.step(observe, conv.body(), { at: T0 + 10 * SEC })).d).toMatchObject({ model: HAIKU, point: 'user-turn' })
    conv.push(assistantText('ok'), userText('and the tests'))
    const later = (await w.step(observe, conv.body(), { at: T0 + 20 * MIN })).d
    expect(later).toMatchObject({ point: 'idle-expired', model: SONNET })
    expect(later.reason).toMatch(/^observe-default: idle-expired/)
  })

  it('an observe-default change holds running lineages until a break point; new lineages get the new default at once', async () => {
    const w = new World()
    const v1 = w.engine(testPolicy({ mode: 'observe', observeDefaults: OBS }))
    const v2 = w.engine(testPolicy({ mode: 'observe', observeDefaults: { ...OBS, 'anthropic-messages': HAIKU } }))
    const conv = new Conversation().push(userText(`fix it ${filler(3000)}`))
    expect((await w.step(v1, conv.body())).d.model).toBe(SONNET)
    turn(conv, 1)
    expect((await w.step(v2, conv.body(), { at: T0 + 5 * SEC })).d).toMatchObject({ model: SONNET, point: 'hard-lock-tool-loop' })
    const other = await w.step(v2, new Conversation().push(userText('hello')).body(), { headers: { 'x-claude-code-session-id': 'sess-new' } })
    expect(other.d).toMatchObject({ model: HAIKU, point: 'session-start' })
    expect(other.d.reason).toMatch(/^observe-default: /)
    conv.push(assistantText('x'), userText('more'))
    expect((await w.step(v2, conv.body(), { at: T0 + 20 * MIN })).d).toMatchObject({ point: 'idle-expired', model: HAIKU })
  })

  it('a model removed from the pool: hard lock retains it, the next user turn moves (ineligible), failover never rotates it', async () => {
    const w = new World()
    const v1 = w.engine(testPolicy())
    const noSonnet = testPolicy()
    noSonnet.pools['anthropic-messages'] = { defaultTier: 'standard', models: [{ model: OPUS }, { model: HAIKU }] }
    const v2 = w.engine(noSonnet)
    const conv = new Conversation().push(userText(`fix it ${filler(3000)}`))
    expect((await w.step(v1, conv.body())).d.model).toBe(SONNET)
    turn(conv, 1)
    expect((await w.step(v2, conv.body(), { at: T0 + 5 * SEC })).d).toMatchObject({ action: 'retain', model: SONNET, point: 'hard-lock-tool-loop' })
    turn(conv, 2)
    const failed = await w.step(v2, conv.body(), { at: T0 + 6 * SEC, status: 503 })
    expect(failed.r.switchedFrom).toBeUndefined()
    // A 503 on a non-pool model: no profile rotation (its failover list is gone with it); the tool loop retains it.
    expect((await w.step(v2, conv.body(), { at: T0 + 7 * SEC })).d).toMatchObject({ model: SONNET, point: 'hard-lock-tool-loop' })
    conv.push(assistantText('done'), userText('next task please'))
    const moved = (await w.step(v2, conv.body(), { at: T0 + 10 * SEC })).d
    expect(moved).toMatchObject({ action: 'switch', point: 'user-turn', model: OPUS })
    expect(parseReason(moved.reason).code).toBe('ineligible')
  })
})

describe('observe projection (0d research §1.6, fixture F4)', () => {
  it('carries the last free choice through hard locks and user turns; a break point takes a fresh one; an auto decision clears it', async () => {
    const w = new World()
    const observe = w.engine(testPolicy({ mode: 'observe', observeDefaults: OBS, userTurn: 'retain' }))
    const conv = new Conversation({ model: 'auto:fast' }).push(userText(`fix it ${filler(3000)}`))
    const a = (await w.step(observe, conv.body())).d
    expect(a).toMatchObject({ model: SONNET, wouldChoose: HAIKU, projected: { model: HAIKU, switch: false } })
    turn(conv, 1)
    const b = (await w.step(observe, conv.body(), { at: T0 + 5 * SEC })).d
    expect(b).toMatchObject({ model: SONNET, wouldChoose: SONNET, point: 'hard-lock-tool-loop', projected: { model: HAIKU, switch: false } })
    conv.push(assistantText('ok'), userText('go on'))
    expect((await w.step(observe, conv.body(), { at: T0 + 10 * SEC })).d.projected).toEqual({ model: HAIKU, switch: false })
    conv.push(assistantText('ok'), userText('the rest'))
    const c = (await w.step(observe, new Conversation({ model: 'auto' }).push(...conv.messages).body(), { at: T0 + 20 * MIN })).d
    expect(c).toMatchObject({ point: 'idle-expired', wouldChoose: SONNET, projected: { model: SONNET, switch: true } })
    const lineage = observe.summarize('anthropic-messages', conv.body(), HDR, w.now).session.lineage
    expect((await w.store.get(lineage))?.projected).toBe(SONNET)
    const auto = w.engine(testPolicy())
    conv.push(assistantText('ok'), userText('auto now'))
    const d = (await w.step(auto, conv.body(), { at: T0 + 21 * MIN })).d
    expect(d.projected).toBeUndefined()
    expect((await w.store.get(lineage))?.projected).toBeUndefined()
  })
})

describe('switchedFrom (0d research §1.2, fixture F2)', () => {
  it('reports the model left and its warm prefix on the call that moved; nothing when staying or failing', async () => {
    const w = new World()
    const e = w.engine(testPolicy())
    const conv = new Conversation().push(userText(`fix it ${filler(20_000)}`))
    const first = await w.step(e, conv.body())
    expect(first.d.model).toBe(SONNET)
    expect(first.r.switchedFrom).toBeUndefined()
    turn(conv, 1)
    const stay = await w.step(e, conv.body(), { at: T0 + 5 * SEC })
    expect(stay.r.switchedFrom).toBeUndefined()
    turn(conv, 2)
    expect((await w.step(e, conv.body(), { at: T0 + 6 * SEC, served: SONNET_JP, status: 429 })).r.switchedFrom).toBeUndefined()
    // The gateway (or a failover) served another model: the lineage moved, with Sonnet's prefix still warm.
    const moved = await w.step(e, conv.body(), { at: T0 + 7 * SEC, served: SONNET_JP })
    expect(moved.r.switchedFrom?.model).toBe(SONNET)
    expect(moved.r.switchedFrom?.warmTokens).toBeGreaterThan(20_000)
    turn(conv, 3)
    // Idle long enough for Sonnet's cache to expire: moving back costs nothing to the old model.
    const back = await w.step(e, conv.body(), { at: T0 + 30 * MIN, served: SONNET })
    expect(back.r.switchedFrom).toEqual({ model: SONNET_JP, warmTokens: 0 })
  })
})

describe('access caps (design 0.16)', () => {
  const standard: Cap = { maxTier: 'standard' }

  it('routing never chooses above maxTier; the decision carries access-cap', async () => {
    const w = new World()
    const e = w.engine(testPolicy())
    const d = (await w.step(e, new Conversation({ model: 'auto:frontier' }).push(userText('design it')).body(), { cap: standard })).d
    expect(d.model).toBe(SONNET)
    expect(parseReason(d.reason)).toMatchObject({ code: 'session-start', accessCap: 'standard', accessCapFrom: 'frontier' })
    const free = (await w.step(e, new Conversation({ model: 'auto' }).push(userText('hi')).body(), { cap: standard, headers: { 'x-claude-code-session-id': 'other' } })).d
    expect(free.model).toBe(SONNET)
    expect(parseReason(free.reason).accessCap).toBeUndefined() // the cap changed nothing
  })

  it('a lineage above a new cap holds through hard locks and moves at its next user turn', async () => {
    const w = new World()
    const e = w.engine(testPolicy())
    const conv = new Conversation({ model: 'auto:frontier' }).push(userText(`design it ${filler(3000)}`))
    expect((await w.step(e, conv.body())).d.model).toBe(OPUS)
    turn(conv, 1)
    const held = (await w.step(e, conv.body(), { at: T0 + 5 * SEC, cap: standard })).d
    expect(held).toMatchObject({ model: OPUS, point: 'hard-lock-tool-loop' })
    expect(parseReason(held.reason).accessCap).toBeUndefined()
    conv.push(assistantText('ok'), userText('continue'))
    const moved = (await w.step(e, conv.body(), { at: T0 + 10 * SEC, cap: standard })).d
    expect(moved).toMatchObject({ action: 'switch', model: SONNET, point: 'user-turn' })
    expect(parseReason(moved.reason)).toMatchObject({ code: 'ineligible', accessCap: 'standard', accessCapFrom: 'frontier' })
  })

  it('observe hold and the cap: an over-cap lineage holds at hard locks (as auto) and moves at its next user turn', async () => {
    const w = new World()
    const auto = w.engine(testPolicy())
    const observe = w.engine(testPolicy({ mode: 'observe', observeDefaults: OBS }))
    const conv = new Conversation({ model: 'auto:frontier' }).push(userText(`design it ${filler(3000)}`))
    expect((await w.step(auto, conv.body())).d.model).toBe(OPUS)
    turn(conv, 1)
    const held = (await w.step(observe, conv.body(), { at: T0 + 5 * SEC, cap: standard })).d
    expect(held).toMatchObject({ model: OPUS, point: 'hard-lock-tool-loop' })
    expect(held.reason).toMatch(/^observe-hold: /)
    conv.push(assistantText('ok'), userText('continue'))
    const moved = (await w.step(observe, conv.body(), { at: T0 + 10 * SEC, cap: standard })).d
    expect(moved).toMatchObject({ model: SONNET, point: 'user-turn' })
    expect(moved.reason).toMatch(/^observe-default: /)
    // Within the cap, the same lineage would have been held at the user turn too.
    const w2 = new World()
    const conv2 = new Conversation({ model: 'auto:fast' }).push(userText(`fix it ${filler(3000)}`))
    expect((await w2.step(w2.engine(testPolicy()), conv2.body())).d.model).toBe(HAIKU)
    conv2.push(assistantText('ok'), userText('continue'))
    expect((await w2.step(w2.engine(testPolicy({ mode: 'observe', observeDefaults: OBS })), conv2.body(), { at: T0 + 10 * SEC, cap: standard })).d)
      .toMatchObject({ model: HAIKU, point: 'user-turn' })
  })

  it('observe: the served model, wouldChoose and projected respect the cap', async () => {
    const w = new World()
    const e = w.engine(testPolicy({ mode: 'observe', observeDefaults: OBS }))
    const d = (await w.step(e, new Conversation({ model: 'auto:frontier' }).push(userText('x')).body(), { cap: { maxTier: 'fast' } })).d
    expect(d).toMatchObject({ model: HAIKU, wouldChoose: HAIKU, projected: { model: HAIKU, switch: false } })
  })

  it('no pool model within the cap → access-cap; nothing within the cap fits the prompt → access-cap-context', async () => {
    const w = new World()
    const noFast = testPolicy()
    noFast.pools['anthropic-messages'] = { defaultTier: 'standard', models: [{ model: OPUS }, { model: SONNET }] }
    const body = new Conversation().push(userText('x')).body()
    await expect(w.step(w.engine(noFast), body, { cap: { maxTier: 'fast' } })).rejects.toMatchObject({ name: 'AccessCapError', code: 'access-cap' })
    // Haiku's window is 200k in the fixture catalog; a 300k prompt fits only the larger models.
    const huge = new Conversation().push(userText(filler(300_000))).body()
    const err = await w.step(w.engine(testPolicy()), huge, { cap: { maxTier: 'fast' }, headers: { 'x-claude-code-session-id': 'huge' } }).catch((x: unknown) => x)
    expect(err).toBeInstanceOf(AccessCapError)
    expect(err).toMatchObject({ code: 'access-cap-context' })
    // Without a cap the same prompt is served (by a model that fits).
    expect((await w.step(w.engine(testPolicy()), huge, { headers: { 'x-claude-code-session-id': 'huge2' } })).d.model).not.toBe(HAIKU)
  })
})

describe('parseReason', () => {
  it('reads code, observe prefix, family/est, gate and access-cap keys; ignores free text', () => {
    expect(parseReason('observe-default: session-start: tier=fast via rule:r1 → x; family=claude-code est=1200; gate-fallback:cheapest; access-cap:standard:frontier'))
      .toEqual({ code: 'session-start', prefix: 'observe-default', family: 'claude-code', est: 1200, gate: 'gate-fallback:cheapest', accessCap: 'standard', accessCapFrom: 'frontier' })
    expect(parseReason('x: y; access-cap:fast')).toEqual({ code: 'x', accessCap: 'fast' }) // older 2-part form
    expect(parseReason('x: y; access-cap:fast:bogus')).toEqual({ code: 'x', accessCap: 'fast' })
    expect(parseReason('hard-lock: tool loop; family=other est=5')).toEqual({ code: 'hard-lock', family: 'other', est: 5 })
    expect(parseReason('pin: concrete model m; family=x est=1')).toMatchObject({ code: 'pin' })
    expect(parseReason('downgrade-rejected:cost: standard→fast a → b saving=$0.0010 need=$0.0200 H=15; family=f est=9').code).toBe('downgrade-rejected')
    expect(parseReason('weird').code).toBe('weird')
    expect(parseReason('x: y; access-cap:ultra').accessCap).toBeUndefined()
  })
})

describe('writeTtlFor (exported for usage ingest, 0d §1.6)', () => {
  it('policy override, else the catalog default TTL, else 5m; exported from @auto-router/core/policy', async () => {
    const pub = await import('./policy-public.ts')
    const p = testPolicy({ cache: { writeTtl: { [SONNET]: '1h' } } })
    const price = (id: string) => fixtureCatalog.models.find((m) => m.modelId === id)
    expect(pub.writeTtlFor(p, SONNET, price(SONNET))).toBe('1h')
    expect(pub.writeTtlFor(p, SOL, price(SOL))).toBe('30m')
    expect(pub.writeTtlFor(p, 'unknown', undefined)).toBe('5m')
    expect(pub.TTL_MS['30m']).toBe(30 * MIN)
  })
})

describe('modelForTier / tierOfPoolModel', () => {
  it('first entry of the tier, else the nearest higher, else lower; failover profiles count as their entry', () => {
    const p = testPolicy()
    expect(modelForTier(p, fixtureCatalog, 'anthropic-messages', 'standard')).toBe(SONNET)
    expect(modelForTier(p, fixtureCatalog, 'openai-chat', 'fast')).toBe(LUNA)
    const noFast = testPolicy()
    noFast.pools['anthropic-messages'] = { defaultTier: 'standard', models: [{ model: OPUS }, { model: SONNET }] }
    expect(modelForTier(noFast, fixtureCatalog, 'anthropic-messages', 'fast')).toBe(SONNET)
    const onlyFast = testPolicy()
    onlyFast.pools['anthropic-messages'] = { defaultTier: 'fast', models: [{ model: HAIKU }] }
    expect(modelForTier(onlyFast, fixtureCatalog, 'anthropic-messages', 'frontier')).toBe(HAIKU)
    expect(tierOfPoolModel(p, fixtureCatalog, 'anthropic-messages', SONNET_JP)).toBe('standard')
    expect(tierOfPoolModel(p, fixtureCatalog, 'anthropic-messages', OPUS)).toBe('frontier')
  })
})

describe('policySwapEffects (0d research §2.4)', () => {
  it('no change → no effects', () => {
    expect(policySwapEffects(testPolicy(), testPolicy(), fixtureCatalog)).toEqual([])
  })

  it('classifies changes, most severe first', () => {
    const prev = testPolicy({ mode: 'observe', observeDefaults: OBS })
    const next = testPolicy({
      mode: 'auto', observeDefaults: { ...OBS, 'anthropic-messages': HAIKU }, userTurn: 'retain',
      aliases: { auto: 'default', 'auto:fast': 'fast', 'auto:standard': 'standard' },
      rules: [{ id: 'r1', when: { lineageKind: 'subagent' }, tier: 'fast' }],
      hysteresis: { costRatio: 1.5 }, portability: { 'openai-encrypted-reasoning': 'same-family' },
    })
    next.pools['anthropic-messages'] = { defaultTier: 'fast', models: [{ model: OPUS, tier: 'standard' }, { model: HAIKU }] }
    delete next.pools['openai-responses']
    const fx = policySwapEffects(prev, next, fixtureCatalog)
    const kinds = fx.map((f) => `${f.severity}:${f.effect}${f.model ? `:${f.model}` : ''}${f.dialect ? `@${f.dialect}` : ''}`)
    expect(kinds).toEqual(expect.arrayContaining([
      'disruptive:pool-removed@openai-responses', `disruptive:pin-removed:${SONNET}`, `disruptive:pin-removed:${SONNET_JP}`,
      'disruptive:alias-removed', `warn:model-removed:${SONNET}@anthropic-messages`, `warn:tier-remap:${OPUS}@anthropic-messages`,
      'warn:portability-loosened', 'info:mode', 'info:default-tier@anthropic-messages', 'info:observe-default@anthropic-messages',
      'info:rules', 'info:user-turn', 'info:tuning',
    ]))
    const rank = { disruptive: 0, warn: 1, info: 2 }
    expect(fx.map((f) => rank[f.severity])).toEqual([...fx.map((f) => rank[f.severity])].sort())
    // Sonnet still pinnable elsewhere? No: removed from the only pool and from observeDefaults.
    expect(fx.find((f) => f.effect === 'alias-removed')?.detail).toMatch(/auto:frontier/)
  })

  it('failover list changes are reported per model', () => {
    const next = testPolicy()
    next.pools['anthropic-messages'] = { defaultTier: 'standard', models: [{ model: OPUS }, { model: SONNET }, { model: HAIKU }] }
    expect(policySwapEffects(testPolicy(), next, fixtureCatalog).map((f) => [f.effect, f.model])).toEqual([
      ['pin-removed', SONNET_JP], ['failover', SONNET],
    ])
  })
})
