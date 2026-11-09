// validateAssessorSettings (research 73 §1.1 / A2): the one validator for env, config document and console.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildManifest } from '@auto-router/assessor'
import { loadCatalog } from '@auto-router/pricing'
import { hasAssessorAdapter } from './config.ts'
import { validateAssessorSettings, type AssessorSettingsContext, type PackInfo, type SettingsCode } from './settings.ts'
import { LUNA } from './test-helpers.ts'

const catalog = loadCatalog('ap-northeast-1')
const manifest = buildManifest()
const packs: PackInfo[] = manifest.packs.map((p) => ({ name: p.name, packVersion: p.packVersion, autoCapable: p.autoCapable }))
const v22 = packs.find((p) => p.name === 'v2.2') as PackInfo
const ctx: AssessorSettingsContext = { catalog, packs, hasAdapter: hasAssessorAdapter }
const good = { mode: 'observe', pack: 'v2.2', packVersion: v22.packVersion, model: LUNA, threshold: 0.8, timeoutMs: 5000, autoRules: 'pack' }
const codes = (raw: unknown, c: AssessorSettingsContext = ctx): SettingsCode[] => {
  const r = validateAssessorSettings(raw, c)
  return r.ok ? [] : r.issues.map((i) => i.code)
}

describe('validateAssessorSettings', () => {
  it('accepts a complete block and returns it unchanged', () => {
    expect(validateAssessorSettings(good, ctx)).toEqual({ ok: true, value: good, warnings: [] })
  })

  it('packVersion is optional (env path)', () => {
    const { packVersion: _, ...noVersion } = good
    expect(validateAssessorSettings(noVersion, ctx)).toMatchObject({ ok: true, value: noVersion })
  })

  it('validates every field also when mode is off (stored blocks stay valid for off → observe)', () => {
    expect(validateAssessorSettings({ ...good, mode: 'off' }, ctx).ok).toBe(true)
    expect(codes({ ...good, mode: 'off', threshold: 2 })).toEqual(['threshold-invalid'])
  })

  it('accepts a bare { mode: off }; observe and auto need every field', () => {
    expect(validateAssessorSettings({ mode: 'off' }, ctx)).toEqual({ ok: true, value: { mode: 'off' }, warnings: [] })
    expect(codes({ mode: 'observe' })).toEqual(['pack-unknown', 'model-invalid', 'threshold-invalid', 'timeout-invalid', 'auto-rules-invalid'])
  })

  it('mode off: image-dependent findings warn for the router, error for the console', () => {
    const offStale = { ...good, mode: 'off', pack: 'v0', model: 'global.openai.no-such' }
    const r = validateAssessorSettings(offStale, ctx)
    expect(r).toMatchObject({ ok: true, value: offStale })
    expect(r.warnings.map((w) => w.code)).toEqual(['pack-unknown', 'model-not-in-catalog'])
    expect(codes(offStale, { ...ctx, offImageChecks: 'error' })).toEqual(['pack-unknown', 'model-not-in-catalog'])
    // Format errors stay errors in both contexts.
    expect(codes({ ...good, mode: 'off', model: 'has space' })).toEqual(['model-invalid'])
  })

  it('model-no-adapter comes from the injected adapter check', () => {
    expect(codes(good, { ...ctx, hasAdapter: () => false })).toEqual(['model-no-adapter'])
  })

  it('is browser-safe: imports only @auto-router/core/policy and @auto-router/pricing (0d review; graph check in runtime.test.ts)', () => {
    const imports = readFileSync(new URL('./settings.ts', import.meta.url), 'utf8').split('\n').filter((l) => /^import\b/.test(l))
    expect(imports.map((l) => /from '([^']+)'/.exec(l)?.[1])).toEqual(['@auto-router/core/policy', '@auto-router/pricing'])
  })

  it.each([
    [{ mode: 'on' }, 'mode-invalid'],
    [{ mode: undefined }, 'mode-invalid'],
    [{ pack: 'v9' }, 'pack-unknown'],
    [{ pack: 22 }, 'pack-unknown'],
    [{ packVersion: 'v2.2' }, 'pack-version-invalid'],
    [{ model: '' }, 'model-invalid'],
    [{ model: 'has space' }, 'model-invalid'],
    [{ model: 'global.openai.no-such' }, 'model-not-in-catalog'],
    [{ threshold: -0.1 }, 'threshold-invalid'],
    [{ threshold: 1.01 }, 'threshold-invalid'],
    [{ threshold: '0.8' }, 'threshold-invalid'],
    [{ threshold: Number.NaN }, 'threshold-invalid'],
    [{ timeoutMs: 99 }, 'timeout-invalid'],
    [{ timeoutMs: 10_001 }, 'timeout-invalid'],
    [{ timeoutMs: 1500.5 }, 'timeout-invalid'],
    [{ autoRules: 'some' }, 'auto-rules-invalid'],
    [{ extra: 1 }, 'unexpected-key'],
  ] as Array<[Record<string, unknown>, SettingsCode]>)('%o → %s', (patch, code) => {
    expect(codes({ ...good, ...patch })).toEqual([code])
  })

  it('accepts the bounds', () => {
    for (const patch of [{ threshold: 0 }, { threshold: 1 }, { timeoutMs: 100 }, { timeoutMs: 10_000 }]) expect(codes({ ...good, ...patch })).toEqual([])
  })

  it('reports every problem at once', () => {
    expect(codes({ mode: 'x', pack: 'x', model: 'x', threshold: 9, timeoutMs: 0, autoRules: 'x' }))
      .toEqual(['mode-invalid', 'pack-unknown', 'model-not-in-catalog', 'threshold-invalid', 'timeout-invalid', 'auto-rules-invalid'])
  })

  it('rejects a non-object', () => {
    for (const raw of [null, 'observe', [], 1]) expect(codes(raw)).toEqual(['object-required'])
  })

  it('auto + autoRules pack needs an auto-capable pack; auto + all is accepted', () => {
    expect(codes({ ...good, mode: 'auto' })).toEqual(['auto-cannot-act'])
    expect(codes({ ...good, mode: 'auto', autoRules: 'all' })).toEqual([])
    const capable = packs.map((p) => (p.name === 'v2.2' ? { ...p, autoCapable: true } : p))
    expect(codes({ ...good, mode: 'auto' }, { ...ctx, packs: capable })).toEqual([])
  })

  it('pack drift: a warning by default (router applies the bundled pack), an error for the console', () => {
    const drifted = { ...good, packVersion: 'assessor/v2.2+000000000000' }
    const warn = validateAssessorSettings(drifted, ctx)
    expect(warn).toMatchObject({ ok: true, warnings: [{ field: 'packVersion', code: 'pack-version-drift' }] })
    expect(codes(drifted, { ...ctx, packVersionMismatch: 'error' })).toEqual(['pack-version-drift'])
  })

  it('checks invokable models only when given (IAM universe: console-only on the runtime path)', () => {
    expect(codes(good, { ...ctx, invokableModels: new Set(['global.openai.gpt-6.1-sol']) })).toEqual(['model-not-invokable'])
    expect(codes(good, { ...ctx, invokableModels: new Set([LUNA]) })).toEqual([])
    const r = validateAssessorSettings(good, { ...ctx, invokableModels: new Set(), invokableLabel: 'the allowed model universe' })
    expect(r.ok ? '' : r.issues[0]?.message).toMatch(/not one of the allowed model universe/)
  })

  it('messages quote at most 80 characters of a bad value', () => {
    const r = validateAssessorSettings({ ...good, pack: 'x'.repeat(500) }, ctx)
    expect(r.ok ? 0 : (r.issues[0]?.message.length ?? 0)).toBeLessThan(200)
  })
})
