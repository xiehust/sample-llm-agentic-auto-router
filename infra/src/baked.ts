// The baked configuration document (0d-effective-config §2–3): what the router runs for every section the active
// document does not set. Built at synth by the router's own bakedConfigDocument, from the inputs the router reads at
// boot: the validated policy, the task definition's environment and the packs of the committed manifest (which the
// image's packs are verified against). Staged to the config bucket as config/baked.json plus the immutable
// config/baked/<version>.json.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Policy } from '@auto-router/core'
import { Token } from 'aws-cdk-lib'
import { bakedConfigDocument, canonicalJson, type BakedEnv, type PackInfo } from '@auto-router/router/settings'

export const BAKED_KEY = 'config/baked.json'
export const bakedVersionKey = (version: string) => `config/baked/${version}.json`
/** Object keys the console may read and the deployment may write (besides packs/*). */
export const BAKED_OBJECTS = [BAKED_KEY, 'config/baked/*'] as const

const MANIFEST = new URL('../../packages/assessor/prompts/assessor/manifest.json', import.meta.url)

/** The committed manifest's packs as PackInfo (the router: packInfos of the image's packs, verified against it). */
export function manifestPacks(file: URL = MANIFEST): PackInfo[] {
  const m = JSON.parse(readFileSync(file, 'utf8')) as { packs?: Array<{ name?: unknown; packVersion?: unknown; autoCapable?: unknown }> }
  return (m.packs ?? []).map((p) => {
    if (typeof p.name !== 'string' || typeof p.packVersion !== 'string' || typeof p.autoCapable !== 'boolean') {
      throw new Error(`assessor manifest: pack entry without name/packVersion/autoCapable (${JSON.stringify(p.name)})`)
    }
    return { name: p.name, packVersion: p.packVersion, autoCapable: p.autoCapable }
  })
}

export interface BakedArtifact { version: string; doc: Record<string, unknown>; json: string }

/** Every env key bakedConfigDocument reads (a Record, so a key added to BakedEnv fails typecheck until listed). */
const BAKED_ENV_KEYS = Object.keys({
  ROUTER_IDENTITY_MODE: 1, ROUTER_ASSESSOR_MODE: 1, ROUTER_ASSESSOR_MODEL: 1, ROUTER_ASSESSOR_THRESHOLD: 1, ROUTER_ASSESSOR_PACK: 1,
  ROUTER_ASSESSOR_TIMEOUT_MS: 1, ROUTER_ASSESSOR_AUTO_RULES: 1,
} satisfies Record<keyof BakedEnv, 1>) as Array<keyof BakedEnv>

/** Paths of unresolved CDK tokens (string, number or list encodings) anywhere in `v`. */
function tokenPaths(v: unknown, path: string, out: string[]): string[] {
  if (Token.isUnresolved(v)) out.push(path)
  else if (Array.isArray(v)) v.forEach((x, i) => tokenPaths(x, `${path}[${i}]`, out))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) tokenPaths(x, `${path}.${k}`, out)
  return out
}

/**
 * The staged artifact: the document without `seq` (a runtime field), in canonical JSON. Synth fails when an input it
 * reads is a deploy-time token: the router hashes the resolved value at boot, the deploy would hash the token's
 * placeholder, and the two versions would differ.
 */
export function bakedArtifact(policy: Policy, env: BakedEnv, packs: readonly PackInfo[] = manifestPacks()): BakedArtifact {
  const tokens = [...BAKED_ENV_KEYS.flatMap((k) => tokenPaths(env[k], `env.${k}`, [])), ...tokenPaths(policy, 'policy', []), ...tokenPaths(packs, 'packs', [])]
  if (tokens.length) throw new Error(`baked config document: deploy-time tokens in its inputs (${tokens.join(', ')}); bake literal values only`)
  const { seq: _seq, ...doc } = bakedConfigDocument({ policy, env, packs }, (t) => createHash('sha256').update(t).digest('hex'))
  const json = canonicalJson(doc)
  if (/[$#]\{Token\[/.test(json) || Token.isUnresolved(json)) throw new Error('baked config document: the canonical JSON contains a deploy-time token')
  return { version: doc.version, doc, json }
}
