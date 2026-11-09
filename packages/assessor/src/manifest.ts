// Pack manifest (admin console task 11-08, research 73 §2): what each shipped pack is, for the router (boot check,
// config lines) and the console (pack picker, basis → rule text for a record's packVersion). Committed as
// prompts/assessor/manifest.json and regenerated with `pnpm --filter @auto-router/assessor manifest`; a golden test
// fails when a pack changes without regeneration. No example cards or outputs, no timestamps, no git data.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Tier } from './contract.ts'
import { DEFAULT_MAPPING, type PackMapping } from './map.ts'
import { defaultPackName, loadPack, packDirs, renderSystem, type Pack, type PackName, type PackRule } from './pack.ts'

export const MANIFEST_SCHEMA_VERSION = 1
/** Path of the committed manifest (copied into the router image with the prompts directory). */
export const manifestPath: string = fileURLToPath(new URL('../prompts/assessor/manifest.json', import.meta.url))

export interface ManifestPack {
  name: PackName
  id: string
  packVersion: string
  card: string
  output: string
  /** The effective mapping (the pack's block, else DEFAULT_MAPPING). */
  mapping: PackMapping
  mappingSource: 'pack' | 'default'
  rules: PackRule[]
  /** Some enabled rule has auto:true (with autoRules 'pack', auto mode can act only then). */
  autoCapable: boolean
  examples: { count: number; byTier: Record<Tier, number> }
  systemChars: number
}

export interface PackManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION
  default: PackName
  packs: ManifestPack[]
}

/** A pack loaded once at boot, with its version (research 73 A1). */
export interface BundledPack { name: PackName; pack: Pack; packVersion: string }

/** Manifest entry of one loaded pack. */
export function manifestEntry(name: PackName, pack: Pack): ManifestPack {
  const { system, packVersion } = renderSystem(pack)
  const byTier: Record<Tier, number> = { fast: 0, standard: 0, frontier: 0 }
  for (const e of pack.examples) byTier[e.tier] += 1
  const m = pack.mapping ?? DEFAULT_MAPPING
  return {
    name, id: pack.id, packVersion, card: pack.card, output: pack.output,
    // Fixed key order (as the version hash uses), copies of the arrays.
    mapping: { frontierFacts: [...m.frontierFacts], priorFailuresMin: m.priorFailuresMin, standardFacts: [...m.standardFacts],
      fastSpecifications: [...m.fastSpecifications], fastDepths: [...m.fastDepths], fastBeatsStandard: m.fastBeatsStandard },
    mappingSource: pack.mapping ? 'pack' : 'default',
    rules: pack.rules.map((r) => ({ id: r.id, tier: r.tier, enabled: r.enabled, auto: r.auto, instruction: r.instruction })),
    autoCapable: pack.rules.some((r) => r.enabled && r.auto),
    examples: { count: pack.examples.length, byTier },
    systemChars: system.length,
  }
}

/** Loads and validates every shipped pack (throws PackError on the first invalid one). */
export function loadBundledPacks(dirs: Readonly<Record<PackName, string>> = packDirs): ReadonlyMap<PackName, BundledPack> {
  const out = new Map<PackName, BundledPack>()
  for (const name of Object.keys(dirs) as PackName[]) {
    const pack = loadPack(dirs[name])
    out.set(name, { name, pack, packVersion: renderSystem(pack).packVersion })
  }
  return out
}

/** The manifest of the given packs (default: every shipped pack). */
export function buildManifest(packs: ReadonlyMap<PackName, BundledPack> = loadBundledPacks()): PackManifest {
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, default: defaultPackName, packs: [...packs.values()].map((b) => manifestEntry(b.name, b.pack)) }
}

/** The manifest file's text: two-space JSON plus a final newline (what the generator writes and the test compares). */
export function manifestText(m: PackManifest): string {
  return `${JSON.stringify(m, null, 2)}\n`
}

/** Reads the committed manifest. */
export function readManifest(path: string = manifestPath): PackManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackManifest
}

/**
 * Boot check (research 73 A1): every loaded pack must appear in the manifest with the same packVersion, and the
 * manifest must list no other pack. Returns the mismatches (empty = consistent).
 */
export function manifestMismatches(packs: ReadonlyMap<PackName, BundledPack>, manifest: PackManifest): string[] {
  const issues: string[] = []
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) issues.push(`manifest: schemaVersion ${String(manifest.schemaVersion)}, expected ${MANIFEST_SCHEMA_VERSION}`)
  const listed = new Map((Array.isArray(manifest.packs) ? manifest.packs : []).map((p) => [p.name, p.packVersion]))
  for (const b of packs.values()) {
    const v = listed.get(b.name)
    if (v === undefined) issues.push(`manifest: pack ${b.name} missing`)
    else if (v !== b.packVersion) issues.push(`manifest: pack ${b.name} is ${v}, loaded ${b.packVersion}`)
  }
  for (const name of listed.keys()) if (!packs.has(name)) issues.push(`manifest: unknown pack ${name}`)
  return issues
}

/**
 * Writes the packs archive for the config bucket (research 73 §2.3): `<outDir>/packs/current.json` (the manifest)
 * and one `<outDir>/packs/<packVersion>.json` per pack (packVersion holds a '/', so e.g.
 * `packs/assessor/v2.2+e2183dce2cb9.json`). RouterStack deploys `<outDir>` to the bucket root with prune off, so
 * entries of older images stay and old records keep resolving. Returns the written keys (relative, '/'-separated).
 */
export function writePacksArchive(outDir: string, manifest: PackManifest = readManifest()): string[] {
  const keys = ['packs/current.json', ...manifest.packs.map((p) => `packs/${p.packVersion}.json`)]
  const bodies = [manifestText(manifest), ...manifest.packs.map((p) => `${JSON.stringify(p, null, 2)}\n`)]
  keys.forEach((k, i) => {
    if (k.includes('..')) throw new Error(`packs archive: bad key ${k}`)
    const file = join(outDir, ...k.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, bodies[i] as string)
  })
  return keys
}
