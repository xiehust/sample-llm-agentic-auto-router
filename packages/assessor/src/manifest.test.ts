// Golden test: the committed manifest equals what the shipped packs generate (research 73 §2.1).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildManifest, writePacksArchive, loadBundledPacks, manifestEntry, manifestMismatches, manifestPath, manifestText, readManifest } from './manifest.ts'
import { loadPack, packDirs, renderSystem } from './pack.ts'

describe('pack manifest', () => {
  it('the committed manifest is up to date (else: pnpm --filter @auto-router/assessor manifest)', () => {
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestText(buildManifest()))
  })

  it('lists every shipped pack with its render version and the default', () => {
    const m = readManifest()
    expect(m.packs.map((p) => p.name)).toEqual(Object.keys(packDirs))
    expect(m.default).toBe('v2.2')
    for (const p of m.packs) expect(p.packVersion).toBe(renderSystem(loadPack(packDirs[p.name])).packVersion)
  })

  it('carries the effective mapping and marks its source', () => {
    const m = readManifest()
    const v21 = m.packs.find((p) => p.name === 'v2.1')
    const v22 = m.packs.find((p) => p.name === 'v2.2')
    expect(v21).toMatchObject({ mappingSource: 'default', mapping: { frontierFacts: ['deep', 'prior-failures'] } })
    expect(v22).toMatchObject({ mappingSource: 'pack', mapping: { frontierFacts: ['prior-failures'] } })
  })

  it('counts examples by tier and holds no example content', () => {
    const e = manifestEntry('v2.2', loadPack(packDirs['v2.2']))
    expect(e.examples).toEqual({ count: 11, byTier: { fast: 4, standard: 5, frontier: 2 } })
    expect(JSON.stringify(e)).not.toMatch(/task_card|latestUser/)
    expect(e.autoCapable).toBe(false)
  })

  it('autoCapable reflects enabled auto rules only', () => {
    const p = loadPack(packDirs['v2.2'])
    const withAuto = { ...p, rules: p.rules.map((r, i) => (i === 0 ? { ...r, auto: true } : r)) }
    expect(manifestEntry('v2.2', withAuto).autoCapable).toBe(true)
    const disabledAuto = { ...p, rules: p.rules.map((r, i) => (i === 0 ? { ...r, auto: true, enabled: false } : r)) }
    expect(manifestEntry('v2.2', disabledAuto).autoCapable).toBe(false)
  })

  it('manifestMismatches: consistent, changed, missing and unknown packs', () => {
    const packs = loadBundledPacks()
    const m = buildManifest(packs)
    expect(manifestMismatches(packs, m)).toEqual([])
    const changed = { ...m, packs: m.packs.map((p) => (p.name === 'v1' ? { ...p, packVersion: 'assessor/v1+000000000000' } : p)) }
    expect(manifestMismatches(packs, changed)).toEqual([expect.stringMatching(/pack v1 is assessor\/v1\+000000000000/)])
    const missing = { ...m, packs: m.packs.filter((p) => p.name !== 'v2') }
    expect(manifestMismatches(packs, missing)).toEqual(['manifest: pack v2 missing'])
    const extra = { ...m, packs: [...m.packs, { ...m.packs[0]!, name: 'v9' as never }] }
    expect(manifestMismatches(packs, extra)).toEqual(['manifest: unknown pack v9'])
  })

  it('packs archive: current.json plus one entry per packVersion, read back as the manifest entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packs-'))
    try {
      const m = readManifest()
      const keys = writePacksArchive(dir, m)
      expect(keys[0]).toBe('packs/current.json')
      expect(keys).toContain('packs/assessor/v2.2+e2183dce2cb9.json')
      expect(JSON.parse(readFileSync(join(dir, 'packs', 'current.json'), 'utf8'))).toEqual(m)
      expect(JSON.parse(readFileSync(join(dir, 'packs', 'assessor', 'v2.2+e2183dce2cb9.json'), 'utf8'))).toEqual(m.packs.find((p) => p.name === 'v2.2'))
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
