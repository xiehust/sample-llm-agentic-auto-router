// Runtime assessor (C4; research 73 §1.2–1.3, A1–A6): the document's assessor block through 0d's AssessorBuilder
// seam, instance reuse, the settings fingerprint, rejection of image-dependent failures, drift on config lines.
import { describe, expect, it } from 'vitest'
import { InMemoryStateStore } from '@auto-router/core'
import { loadBundledPacks, packDirs } from '@auto-router/assessor'
import { loadCatalog } from '@auto-router/pricing'
import { createAssessorRuntime } from './assessor-runtime.ts'
import { createRuntime } from './runtime.ts'
import { bakedDocument, validateConfigDocument, type ConfigDocument } from './settings.ts'
import { LUNA, testPolicy } from './test-helpers.ts'

const catalog = loadCatalog('ap-northeast-1')
const packs = loadBundledPacks()
const v22 = packs.get('v2.2')!
const transport = async () => ({ status: 500, body: '{}' })
const block = (over: Record<string, unknown> = {}) => ({ mode: 'observe', pack: 'v2.2', packVersion: v22.packVersion, model: LUNA, threshold: 0.8, timeoutMs: 5000, autoRules: 'pack', ...over })
const docOf = (n: number, assessor?: unknown): ConfigDocument => {
  const r = validateConfigDocument({ schemaVersion: 1, version: `${n}-20261108T010000Z`, policy: { ...JSON.parse(JSON.stringify(testPolicy())), version: `p${n}` }, ...(assessor !== undefined ? { assessor } : {}) }, catalog)
  if (!r.ok) throw new Error(r.issues.join('; '))
  return r.value
}
const envOff = { mode: 'off' as const }
const envObserve = { mode: 'observe' as const, model: LUNA, threshold: 0.8, packName: 'v2.1' as const, pack: packs.get('v2.1')!.pack, timeoutMs: 5000, autoRules: 'pack' as const }

describe('assessor builder', () => {
  it('no block: the env assessor (or none); a bare off block: none', () => {
    expect(createAssessorRuntime({ env: envOff, packs, catalog, transport }).build(docOf(1))).toEqual({ ok: true })
    const rt = createAssessorRuntime({ env: envObserve, packs, catalog, transport })
    const r = rt.build(docOf(1))
    expect(r.ok && r.assessor).toBe(rt.envAssessor)
    expect(rt.build(docOf(2, { mode: 'off' }))).toEqual({ ok: true })
  })

  it('a block builds from the preloaded pack; identical settings reuse the instance across documents', () => {
    const rt = createAssessorRuntime({ env: envOff, packs, catalog, transport })
    const a = rt.build(docOf(1, block()))
    const b = rt.build(docOf(2, block()))
    if (!a.ok || !b.ok) throw new Error('expected ok')
    expect(a.assessor?.packVersion).toBe(v22.packVersion)
    expect(a.assessor?.settings).toMatchObject({ mode: 'observe', packName: 'v2.2', model: LUNA })
    expect(b.assessor).toBe(a.assessor)
    expect(rt.build(docOf(3, block({ mode: 'auto', autoRules: 'all' })))).toMatchObject({ ok: true })
  })

  it('fingerprint (A4): threshold / autoRules / pack change the consultation key core sees; timeout does not; logs keep pack@model', () => {
    const rt = createAssessorRuntime({ env: envOff, packs, catalog, transport })
    const idOf = (over: Record<string, unknown>) => { const r = rt.build(docOf(1, block(over))); if (!r.ok || !r.assessor) throw new Error('x'); return r.assessor.engineOptions.assessor!.id }
    const base = idOf({})
    expect(base).toMatch(/^assessor\/v2\.2@global\.openai\.gpt-6-luna#[0-9a-f]{8}$/)
    expect(idOf({ threshold: 0.7 })).not.toBe(base)
    expect(idOf({ autoRules: 'all', mode: 'auto' })).not.toBe(base)
    expect(idOf({ pack: 'v2.1', packVersion: packs.get('v2.1')!.packVersion })).not.toBe(base)
    expect(idOf({ timeoutMs: 3000 })).toBe(base)
    const r = rt.build(docOf(1, block())); if (!r.ok || !r.assessor) throw new Error('x')
    expect(r.assessor.id).toBe(`assessor/v2.2@${LUNA}`)
  })

  it('image-dependent failures reject the document (keep the last good); drift and stale off blocks only warn', () => {
    const rt = createAssessorRuntime({ env: envOff, packs, catalog, transport })
    expect(rt.build(docOf(1, block({ pack: 'v9' })))).toEqual({ ok: false, issues: [expect.stringMatching(/^assessor\.pack: pack-unknown/)] })
    expect(rt.build(docOf(1, block({ model: 'global.openai.no-such' })))).toMatchObject({ ok: false, issues: [expect.stringMatching(/model-not-in-catalog/)] })
    expect(rt.build(docOf(1, block({ mode: 'auto' })))).toMatchObject({ ok: false, issues: [expect.stringMatching(/auto-cannot-act/)] })
    const drift = rt.build(docOf(1, block({ packVersion: 'assessor/v2.2+000000000000' })))
    expect(drift).toMatchObject({ ok: true, warnings: [expect.stringMatching(/pack-version-drift/)] })
    expect(rt.build(docOf(1, block({ mode: 'off', pack: 'v0' })))).toMatchObject({ ok: true, warnings: [expect.stringMatching(/pack-unknown/)] })
  })
})

describe('runtime integration (config lines A6)', () => {
  it('off → observe at runtime; config lines carry the assessor, the image packs and drift', () => {
    const lines: Record<string, any>[] = []
    const ar = createAssessorRuntime({ env: envOff, packs, catalog, transport })
    const rt = createRuntime(bakedDocument(testPolicy()), { catalog, store: new InMemoryStateStore(), sink: (l) => lines.push(JSON.parse(l)), buildAssessor: ar.build, lineFields: [ar.lineFields] })
    expect(rt.current().assessor).toBeUndefined()
    const raw = { schemaVersion: 1, version: '1-20261108T010000Z', policy: { ...JSON.parse(JSON.stringify(testPolicy())), version: 'p1' }, assessor: block({ packVersion: 'assessor/v2.2+000000000000' }) }
    expect(rt.applyDocument(raw)).toMatchObject({ outcome: 'applied' })
    expect(rt.current().assessor?.settings.packName).toBe('v2.2')
    const line = lines.at(-1)!
    expect(line).toMatchObject({ kind: 'config', source: 'config', outcome: 'applied', configVersion: '1-20261108T010000Z',
      assessor: { id: `assessor/v2.2@${LUNA}`, mode: 'observe', pack: 'v2.2', packVersion: v22.packVersion, model: LUNA, threshold: 0.8, timeoutMs: 5000, autoRules: 'pack' },
      drift: { pack: 'v2.2', expected: 'assessor/v2.2+000000000000', loaded: v22.packVersion } })
    expect(line.packs.map((p: any) => p.name)).toEqual(Object.keys(packDirs))
    // A rejected block keeps the last good generation.
    expect(rt.applyDocument({ ...raw, version: '2-20261108T010000Z', assessor: block({ pack: 'v9' }) })).toMatchObject({ outcome: 'rejected' })
    expect(rt.current().configVersion).toBe('1-20261108T010000Z')
    // observe → off.
    expect(rt.applyDocument({ ...raw, version: '3-20261108T010000Z', assessor: { mode: 'off' } })).toMatchObject({ outcome: 'applied' })
    expect(rt.current().assessor).toBeUndefined()
    expect(lines.at(-1)).toMatchObject({ assessor: { mode: 'off' } })
    expect(lines.at(-1)).not.toHaveProperty('drift')
  })
})
