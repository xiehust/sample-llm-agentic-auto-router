// The optional pack.json `mapping` block (v2.2): validation, each parameter, and identity with the old mapping when
// the block equals DEFAULT_MAPPING.
import { describe, expect, it } from 'vitest'
import { output } from './__fixtures__/fixtures.ts'
import { DEFAULT_MAPPING, mapTier, type PackMapping } from './map.ts'
import { loadPack, packDirs, renderSystem, validatePack, type PackRule } from './pack.ts'

const rule = (id: string, tier: PackRule['tier']): PackRule => ({ id, tier, enabled: true, auto: false, instruction: id })
const RULES: PackRule[] = [rule('explore-readonly', 'fast'), rule('mechanical-edit', 'fast'), rule('bounded-change', 'standard'), rule('deep-investigation', 'frontier')]
const withMapping = (m: Partial<PackMapping>): PackMapping => ({ ...DEFAULT_MAPPING, ...m })

describe('mapping parameters', () => {
  it('frontierFacts without deep: a deep fact alone no longer yields frontier', () => {
    const a = output(['bounded-change'], { reasoning_depth: 'deep', edits_code: true, scope: 'single-file' })
    expect(mapTier(a, RULES).proposedTier).toBe('frontier')
    const m = mapTier(a, RULES, { mapping: withMapping({ frontierFacts: ['prior-failures'] }) })
    expect([m.proposedTier, m.basis]).toEqual(['standard', ['bounded-change']])
  })
  it('a frontier rule still yields frontier when no fact may', () => {
    const a = output(['deep-investigation'], { reasoning_depth: 'deep' })
    expect(mapTier(a, RULES, { mapping: withMapping({ frontierFacts: [] }) }).basis).toEqual(['deep-investigation'])
  })
  it('priorFailuresMin', () => {
    const a = output(['bounded-change'], { reasoning_depth: 'routine', prior_failures: 2 })
    expect(mapTier(a, RULES).proposedTier).toBe('frontier')
    expect(mapTier(a, RULES, { mapping: withMapping({ priorFailuresMin: 3 }) }).proposedTier).toBe('standard')
  })
  it('standardFacts empty: a multi-file edit alone gives no opinion', () => {
    const a = output([], { reasoning_depth: 'routine', edits_code: true, scope: 'multi-file' })
    expect(mapTier(a, RULES).proposedTier).toBe('standard')
    expect(mapTier(a, RULES, { mapping: withMapping({ standardFacts: [] }) }).outcome).toBe('no-rule')
  })
  it('fast settling conditions', () => {
    const a = output(['mechanical-edit'], { reasoning_depth: 'routine', specification: 'partially', edits_code: true, scope: 'single-file' })
    expect(mapTier(a, RULES).outcome).toBe('fast-unsettled')
    const m = mapTier(a, RULES, { mapping: withMapping({ fastSpecifications: ['fully-specified', 'partially'] }) })
    expect([m.proposedTier, m.basis]).toEqual(['fast', ['mechanical-edit']])
    const deep = output(['mechanical-edit'], { reasoning_depth: 'lookup', specification: 'fully-specified' })
    expect(mapTier(deep, RULES, { mapping: withMapping({ fastDepths: ['routine'] }) }).outcome).toBe('fast-unsettled')
  })
})

describe('fastBeatsStandard', () => {
  const a = output(['mechanical-edit', 'bounded-change'], { reasoning_depth: 'routine', specification: 'fully-specified', edits_code: true, scope: 'multi-file' })
  it('off (default): a standard rule wins', () => {
    expect(mapTier(a, RULES).proposedTier).toBe('standard')
  })
  it('on: a settled fast match wins over standard rules and facts', () => {
    const m = mapTier(a, RULES, { mapping: withMapping({ fastBeatsStandard: true }) })
    expect([m.proposedTier, m.basis]).toEqual(['fast', ['mechanical-edit']])
  })
  it('on, but unsettled: standard still wins', () => {
    const u = output(['mechanical-edit', 'bounded-change'], { reasoning_depth: 'routine', specification: 'partially', edits_code: true, scope: 'single-file' })
    expect(mapTier(u, RULES, { mapping: withMapping({ fastBeatsStandard: true }) }).proposedTier).toBe('standard')
  })
  it('on: frontier signals still win over fast', () => {
    const d = output(['mechanical-edit'], { reasoning_depth: 'deep', specification: 'fully-specified' })
    expect(mapTier(d, RULES, { mapping: withMapping({ fastBeatsStandard: true }) }).proposedTier).toBe('frontier')
  })
})

describe('pack.json mapping block', () => {
  const v21 = loadPack(packDirs['v2.1'])
  const base = { id: 'assessor/test', card: 'card/v1', output: 'assessment/v1', instructions: v21.instructions, rules: v21.rules, examples: v21.examples }

  it('absent: no mapping on the pack', () => {
    expect(validatePack(base).mapping).toBeUndefined()
  })
  it('partial block: missing keys take DEFAULT_MAPPING', () => {
    expect(validatePack({ ...base, mapping: { frontierFacts: ['prior-failures'] } }).mapping).toEqual(withMapping({ frontierFacts: ['prior-failures'] }))
  })
  it.each([
    [{ frontierFacts: ['multi-file-edit'] }, 'mapping.frontierFacts'],
    [{ frontierFacts: ['deep', 'deep'] }, 'mapping.frontierFacts'],
    [{ fastDepths: 'lookup' }, 'mapping.fastDepths'],
    [{ priorFailuresMin: 0 }, 'mapping.priorFailuresMin'],
    [{ priorFailuresMin: 2.5 }, 'mapping.priorFailuresMin'],
    [{ extra: true }, 'unexpected key extra'],
    [{ fastBeatsStandard: 'yes' }, 'mapping.fastBeatsStandard'],
  ])('rejects %j', (mapping, msg) => {
    expect(() => validatePack({ ...base, mapping })).toThrow(msg)
  })
  it('examples are self-checked under the block: v2.1 fast examples no longer settle when only deep depth may', () => {
    expect(() => validatePack({ ...base, mapping: { fastDepths: ['deep'] } })).toThrow(/maps to fast-unsettled/)
  })
  it('the block is part of the prompt version; a default-equal block maps like no block', () => {
    const plain = validatePack(base)
    const dflt = validatePack({ ...base, mapping: {} })
    expect(renderSystem(dflt).packVersion).not.toBe(renderSystem(plain).packVersion)
    expect(renderSystem(dflt).system).toBe(renderSystem(plain).system)
    const other = validatePack({ ...base, mapping: { priorFailuresMin: 3 } })
    expect(renderSystem(other).packVersion).not.toBe(renderSystem(dflt).packVersion)
  })
})

describe('v2.2 pack', () => {
  it('is the default: the frozen v2.2-D content (narrow frontier, no new fast rule), every rule auto:false', async () => {
    const p = loadPack(packDirs['v2.2'])
    expect(p.id).toBe('assessor/v2.2')
    const { defaultPackDir, defaultPackName } = await import('./pack.ts')
    expect(defaultPackName).toBe('v2.2')
    expect(defaultPackDir).toBe(packDirs['v2.2'])
    // The hash excludes the id: same as v2.2-D's frozen version (experiments/assessor-v22/packs/FROZEN.json).
    expect(renderSystem(p).packVersion).toBe('assessor/v2.2+e2183dce2cb9')
    expect(p.mapping).toEqual({ ...DEFAULT_MAPPING, frontierFacts: ['prior-failures'] })
    expect(p.rules.map((r) => [r.id, r.tier, r.enabled, r.auto])).toEqual(loadPack(packDirs['v2.1']).rules.map((r) => [r.id, r.tier, r.enabled, r.auto]))
  })
})
