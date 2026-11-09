import { Aws, Lazy, Token } from 'aws-cdk-lib'
import { describe, expect, it } from 'vitest'
import { bakedArtifact, manifestPacks } from './baked.ts'
import { DEFAULT_POLICY_FILE, deployModels } from './models.ts'
import { resolveSettings } from './settings.ts'

const settings = resolveSettings({ tryGetContext: (k: string) => ({ region: 'ap-southeast-1', account: '000000000000' } as Record<string, string>)[k] }, {}, DEFAULT_POLICY_FILE)
const policy = deployModels(settings).policy
const env = { ROUTER_IDENTITY_MODE: 'observe', ROUTER_ASSESSOR_MODE: 'observe' }

describe('bakedArtifact', () => {
  it('literal inputs: a 0-baked.<sha8> document without seq, deterministic', () => {
    const a = bakedArtifact(policy, env)
    expect(a.version).toMatch(/^0-baked\.[0-9a-f]{8}$/)
    expect(a.doc).not.toHaveProperty('seq')
    expect(bakedArtifact(policy, { ...env }).json).toBe(a.json)
    expect(manifestPacks().length).toBeGreaterThan(0)
  })

  it('fails synth on a deploy-time token in any env key it reads (string, number and list encodings)', () => {
    const cases: Array<[string, string]> = [
      ['ROUTER_IDENTITY_MODE', Aws.REGION],
      ['ROUTER_ASSESSOR_MODEL', `prefix-${Aws.ACCOUNT_ID}`],
      ['ROUTER_ASSESSOR_THRESHOLD', Token.asString(Lazy.number({ produce: () => 0.7 }))],
      ['ROUTER_ASSESSOR_PACK', Token.asString(Lazy.list({ produce: () => ['v2.2'] }))],
    ]
    for (const [k, v] of cases) expect(() => bakedArtifact(policy, { ...env, [k]: v }), k).toThrow(new RegExp(`deploy-time tokens.*env\\.${k}`))
    // Keys the document does not read may hold tokens (the task env has ARNs and ids).
    expect(() => bakedArtifact(policy, { ...env, ROUTER_GATEWAY_ARN: Aws.ACCOUNT_ID } as typeof env)).not.toThrow()
  })

  it('fails synth on a token anywhere in the policy', () => {
    const tokenPolicy = { ...policy, version: `v-${Aws.STACK_NAME}` }
    expect(() => bakedArtifact(tokenPolicy, env)).toThrow(/deploy-time tokens.*policy\.version/)
    const nested = JSON.parse(JSON.stringify(policy)) as Record<string, any>
    const pool = Object.values(nested.pools as Record<string, { models: Array<Record<string, unknown>> }>)[0] as { models: Array<Record<string, unknown>> }
    ;(pool.models[0] as Record<string, unknown>).model = Lazy.string({ produce: () => 'm' })
    expect(() => bakedArtifact(nested as typeof policy, env)).toThrow(/deploy-time tokens.*policy\.pools\..*\.models\[0\]\.model/)
  })
})
