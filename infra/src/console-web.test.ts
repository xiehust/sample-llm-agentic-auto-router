import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App, Stack, aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_s3 as s3 } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { describe, expect, it } from 'vitest'
import { checkBundle, consoleBundleSettings, consoleHeadersPolicy, consoleSpaFunction, ConsoleWeb, ConsoleBundleError } from './console-web.ts'

const SHA = 'a'.repeat(40)

function fixture(build: { gitSha?: string; dirty?: boolean } = { gitSha: SHA, dirty: false }) {
  const dir = mkdtempSync(join(tmpdir(), 'llmar-console-dist-'))
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id=root></div>')
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)')
  writeFileSync(join(dir, 'third-party-licenses.txt'), 'x')
  writeFileSync(join(dir, 'build.json'), JSON.stringify(build))
  return dir
}

function synth(bundle: boolean, distDir = fixture(), expectedGitSha: string | null = SHA) {
  const app = new App({ outdir: mkdtempSync(join(tmpdir(), 'llmar-console-cdk-')) })
  const stack = new Stack(app, 'console-test', { env: { account: '000000000000', region: 'ap-southeast-1' } })
  const bucket = new s3.Bucket(stack, 'Site', { blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true })
  const fn = consoleSpaFunction(stack, 'Rewrite')
  const headers = consoleHeadersPolicy(stack, 'Headers', 'https://llmar-x.auth.ap-southeast-1.amazoncognito.com')
  const distribution = new cloudfront.Distribution(stack, 'Cdn', {
    defaultBehavior: {
      origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
      functionAssociations: [{ function: fn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      responseHeadersPolicy: headers,
    },
    defaultRootObject: 'index.html',
  })
  new ConsoleWeb(stack, 'Console', {
    bucket, distribution, settings: { bundle, distDir, allowDirty: false }, ...(expectedGitSha !== null ? { expectedGitSha } : {}),
    runtimeConfig: { region: 'ap-southeast-1', issuer: 'https://cognito-idp.ap-southeast-1.amazonaws.com/pool', cognitoDomain: 'https://llmar-x.auth.ap-southeast-1.amazoncognito.com', clientId: 'cid', scopes: ['openid', 'llmar/console'] },
  })
  return Template.fromStack(stack)
}

describe('console bundle wiring (consoleBundle flag)', () => {
  it('consoleBundle=false creates no BucketDeployment (first deploy: empty bucket)', () => {
    const t = synth(false)
    expect(Object.keys(t.findResources('Custom::CDKBucketDeployment'))).toHaveLength(0)
  })

  it('consoleBundle=true uploads immutable assets, then no-cache entry points with /config.json and an invalidation', () => {
    const t = synth(true)
    const deps = Object.values(t.findResources('Custom::CDKBucketDeployment')) as Array<{ Properties: Record<string, unknown>; DependsOn?: string[] }>
    expect(deps).toHaveLength(2)
    const assets = deps.find((d) => d.Properties.DestinationBucketKeyPrefix === 'assets/')!
    const entry = deps.find((d) => d.Properties.DestinationBucketKeyPrefix !== 'assets/')!
    expect(JSON.stringify(assets.Properties.SystemMetadata)).toContain('max-age=31536000, immutable')
    expect(assets.Properties.Prune).toBe(false)
    expect(JSON.stringify(entry.Properties.SystemMetadata)).toContain('no-cache')
    expect(entry.Properties.DistributionPaths).toEqual(['/index.html', '/config.json', '/favicon.svg', '/third-party-licenses.txt'])
    // dist (minus assets/ and build.json) plus the generated /config.json
    expect(entry.Properties.SourceObjectKeys).toHaveLength(2)
    expect(entry.DependsOn?.some((d) => d.includes('ConsoleAssets'))).toBe(true)
  })

  it('refuses a missing, stale or dirty bundle', () => {
    expect(() => checkBundle(join(tmpdir(), 'nope-dist'), SHA, false)).toThrow(/no console bundle/)
    expect(() => synth(true, fixture({ gitSha: 'b'.repeat(40), dirty: false }))).toThrow(/not HEAD/)
    expect(() => synth(true, fixture({ gitSha: SHA, dirty: true }))).toThrow(/dirty tree/)
    expect(() => synth(true, fixture(), null)).toThrow(ConsoleBundleError)
    expect(checkBundle(fixture({ gitSha: SHA, dirty: true }), SHA, true).gitSha).toBe(SHA)
  })

  it('reads the context flags (default off)', () => {
    const ctx = (c: Record<string, unknown>) => ({ tryGetContext: (k: string) => c[k] })
    expect(consoleBundleSettings(ctx({})).bundle).toBe(false)
    expect(consoleBundleSettings(ctx({ consoleBundle: 'true' })).bundle).toBe(true)
    expect(consoleBundleSettings(ctx({ consoleBundle: 'false', consoleDist: '/x' }))).toMatchObject({ bundle: false, distDir: '/x', allowDirty: false })
  })

  it('serves the tested strict CSP and headers, and the SPA rewrite function', () => {
    const t = synth(false)
    const policies = Object.values(t.findResources('AWS::CloudFront::ResponseHeadersPolicy')) as Array<{ Properties: { ResponseHeadersPolicyConfig: Record<string, any> } }>
    const cfg = policies[0]!.Properties.ResponseHeadersPolicyConfig
    const csp = cfg.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy as string
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("connect-src 'self' https://llmar-x.auth.ap-southeast-1.amazoncognito.com")
    expect(csp).toContain('upgrade-insecure-requests')
    expect(csp).not.toMatch(/unsafe-/)
    expect(cfg.SecurityHeadersConfig.FrameOptions.FrameOption).toBe('DENY')
    expect(cfg.SecurityHeadersConfig.ReferrerPolicy.ReferrerPolicy).toBe('no-referrer')
    const fns = Object.values(t.findResources('AWS::CloudFront::Function')) as Array<{ Properties: { FunctionCode: string; FunctionConfig: { Runtime: string } } }>
    expect(fns[0]!.Properties.FunctionConfig.Runtime).toBe('cloudfront-js-2.0')
    expect(fns[0]!.Properties.FunctionCode).toContain("'/index.html'")
  })
})
