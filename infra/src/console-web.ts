// Console SPA hosting pieces for the ConsoleStack (admin console design 0.7, implement Phase 3): the bundle upload
// behind the consoleBundle context flag, /config.json injection, the SPA rewrite CloudFront Function and the response
// headers policy. Headers and CSP come from @auto-router/console-web/security-headers, the module `vite preview`
// serves in the Playwright smoke, so the deployed policy is the tested one.
//
// Deploy order (implement Phase 3): first deploy with -c consoleBundle=false (no BucketDeployment; the bucket stays
// empty), verify anonymous denial of every /api/* route and S3 direct access, then redeploy with consoleBundle=true.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Duration, aws_cloudfront as cloudfront, aws_s3 as s3, aws_s3_deployment as s3deploy } from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { CACHE_CONTROL, contentSecurityPolicy, PERMISSIONS_POLICY, SPA_REWRITE_FUNCTION } from '@auto-router/console-web/security-headers'
import type { Ctx } from './settings.ts'

export const DEFAULT_CONSOLE_DIST = new URL('../../packages/console-web/dist', import.meta.url).pathname

/** The non-secret values the SPA needs before sign-in (packages/console-web/src/config/runtime-config.ts). */
export interface ConsoleRuntimeConfig {
  region: string
  /** https://cognito-idp.<region>.amazonaws.com/<userPoolId> (a token is fine). */
  issuer: string
  /** Managed login domain origin, https://<prefix>.auth.<region>.amazoncognito.com (a token is fine). */
  cognitoDomain: string
  clientId: string
  /** e.g. ['openid', '<prefix>/console'] */
  scopes: string[]
  tokenStorage?: 'session' | 'memory'
}

export interface ConsoleBundleSettings {
  /** -c consoleBundle=true uploads the bundle; anything else uploads nothing. */
  bundle: boolean
  distDir: string
  /** -c consoleAllowDirty=true accepts a bundle built from a dirty tree (local experiments only). */
  allowDirty: boolean
}

export function consoleBundleSettings(node: Ctx): ConsoleBundleSettings {
  const flag = (k: string) => { const v: unknown = node.tryGetContext(k); return v === true || v === 'true' }
  const dist: unknown = node.tryGetContext('consoleDist')
  return { bundle: flag('consoleBundle'), distDir: typeof dist === 'string' && dist ? dist : DEFAULT_CONSOLE_DIST, allowDirty: flag('consoleAllowDirty') }
}

export class ConsoleBundleError extends Error {
  constructor(message: string) { super(message); this.name = 'ConsoleBundleError' }
}

/**
 * Refuses a missing, stale or dirty bundle: dist/build.json must name `expectedGitSha` (the deploying worktree's
 * HEAD) and a clean tree, so the uploaded SPA is the reviewed commit (deploys come from a clean worktree).
 */
export function checkBundle(distDir: string, expectedGitSha: string | undefined, allowDirty: boolean): { gitSha: string } {
  const index = join(distDir, 'index.html')
  const info = join(distDir, 'build.json')
  if (!existsSync(index) || !existsSync(info)) throw new ConsoleBundleError(`no console bundle at ${distDir}: run \`pnpm --filter @auto-router/console-web build\` first`)
  const b = JSON.parse(readFileSync(info, 'utf8')) as { gitSha?: string; dirty?: boolean }
  if (!b.gitSha || b.gitSha === 'unknown') throw new ConsoleBundleError('dist/build.json has no gitSha (built outside a git checkout)')
  if (expectedGitSha && b.gitSha !== expectedGitSha) throw new ConsoleBundleError(`console bundle was built from ${b.gitSha.slice(0, 12)}, not HEAD ${expectedGitSha.slice(0, 12)}: rebuild`)
  if (b.dirty && !allowDirty) throw new ConsoleBundleError('console bundle was built from a dirty tree: build from a clean worktree (or -c consoleAllowDirty=true for experiments)')
  return { gitSha: b.gitSha }
}

export interface ConsoleWebProps {
  bucket: s3.IBucket
  distribution: cloudfront.IDistribution
  runtimeConfig: ConsoleRuntimeConfig
  settings: ConsoleBundleSettings
  /** HEAD of the deploying worktree (`git rev-parse HEAD`); required when settings.bundle is true. */
  expectedGitSha?: string
}

/**
 * Uploads the bundle when settings.bundle is true: hashed assets/** as immutable (prune: false, so tabs on the old
 * version can still load their chunks), then index.html, favicon, licences and /config.json as no-cache with a
 * CloudFront invalidation. With settings.bundle false it creates nothing.
 */
export class ConsoleWeb extends Construct {
  readonly deployments: s3deploy.BucketDeployment[] = []

  constructor(scope: Construct, id: string, props: ConsoleWebProps) {
    super(scope, id)
    if (!props.settings.bundle) return
    if (!props.expectedGitSha) throw new ConsoleBundleError('consoleBundle=true needs the deploying HEAD (expectedGitSha)')
    checkBundle(props.settings.distDir, props.expectedGitSha, props.settings.allowDirty)
    const c = props.runtimeConfig
    const assets = new s3deploy.BucketDeployment(this, 'Assets', {
      destinationBucket: props.bucket,
      destinationKeyPrefix: 'assets/',
      sources: [s3deploy.Source.asset(join(props.settings.distDir, 'assets'))],
      cacheControl: [s3deploy.CacheControl.fromString(CACHE_CONTROL.assets)],
      prune: false,
      memoryLimit: 256,
    })
    const entry = new s3deploy.BucketDeployment(this, 'Entry', {
      destinationBucket: props.bucket,
      sources: [
        s3deploy.Source.asset(props.settings.distDir, { exclude: ['assets', 'assets/**', 'build.json', 'config.json'] }),
        s3deploy.Source.jsonData('config.json', {
          schemaVersion: 1, region: c.region, issuer: c.issuer, cognitoDomain: c.cognitoDomain, clientId: c.clientId, scopes: c.scopes, apiBase: '/api', tokenStorage: c.tokenStorage ?? 'session',
        }),
      ],
      cacheControl: [s3deploy.CacheControl.fromString(CACHE_CONTROL.entry)],
      prune: false,
      distribution: props.distribution,
      distributionPaths: ['/index.html', '/config.json', '/favicon.svg', '/third-party-licenses.txt'],
      memoryLimit: 256,
    })
    entry.node.addDependency(assets)
    this.deployments.push(assets, entry)
  }
}

/** Viewer-request function for the default (S3) behavior: SPA routes → /index.html. Not for /api/*. */
export function consoleSpaFunction(scope: Construct, id: string): cloudfront.Function {
  return new cloudfront.Function(scope, id, { code: cloudfront.FunctionCode.fromInline(SPA_REWRITE_FUNCTION), runtime: cloudfront.FunctionRuntime.JS_2_0, comment: 'console SPA routes to /index.html' })
}

/** Response headers for the default behavior. cognitoOrigin may be a CDK token that resolves to an origin. */
export function consoleHeadersPolicy(scope: Construct, id: string, cognitoOrigin: string): cloudfront.ResponseHeadersPolicy {
  return new cloudfront.ResponseHeadersPolicy(scope, id, {
    comment: 'console SPA: strict CSP and security headers',
    securityHeadersBehavior: {
      contentSecurityPolicy: { contentSecurityPolicy: contentSecurityPolicy({ cognitoOrigin, upgradeInsecure: true, originIsResolved: true }), override: true },
      strictTransportSecurity: { accessControlMaxAge: Duration.seconds(63_072_000), includeSubdomains: true, override: true },
      contentTypeOptions: { override: true },
      frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
      referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
    },
    customHeadersBehavior: {
      customHeaders: [
        { header: 'permissions-policy', value: PERMISSIONS_POLICY, override: true },
        { header: 'cross-origin-opener-policy', value: 'same-origin', override: true },
        { header: 'cross-origin-resource-policy', value: 'same-origin', override: true },
      ],
    },
  })
}

/** Response headers for /api/*: no CSP (JSON), the rest of the hardening; Lambda sets cache-control: no-store. */
export function consoleApiHeadersPolicy(scope: Construct, id: string): cloudfront.ResponseHeadersPolicy {
  return new cloudfront.ResponseHeadersPolicy(scope, id, {
    comment: 'console API: security headers',
    securityHeadersBehavior: {
      strictTransportSecurity: { accessControlMaxAge: Duration.seconds(63_072_000), includeSubdomains: true, override: true },
      contentTypeOptions: { override: true },
      referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
    },
  })
}
