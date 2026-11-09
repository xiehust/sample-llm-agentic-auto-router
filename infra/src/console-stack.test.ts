import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseRuntimeConfig } from '@auto-router/console-web/runtime-config'
import { App, Validations, aws_ecr as ecr, aws_lambda as lambda } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks } from 'cdk-nag'
import { describe, expect, it } from 'vitest'
import { ConsoleStack, contentSecurityPolicy, INGEST_FILTER, LAMBDA_CMD, resolveConsoleSettings, routerParamName, SPA_CONFIG_KEY, SPA_REWRITE, type ConsoleSettings } from './console-stack.ts'

const ctx = (c: Record<string, string>) => ({ tryGetContext: (k: string) => c[k] })
const BASE = { region: 'ap-southeast-1', account: '000000000000' }
const settings = (c: Record<string, string> = {}) => resolveConsoleSettings(ctx({ ...BASE, ...c }), {})

function build(cfg: ConsoleSettings, nag = false) {
  const app = new App({ outdir: `/tmp/llmar-console-test-${process.pid}-${Math.random().toString(36).slice(2)}` })
  const stack = new ConsoleStack(app, 'llmar-console', { env: { account: cfg.account, region: cfg.region }, settings: cfg,
    code: (s, cmd) => lambda.DockerImageCode.fromEcr(ecr.Repository.fromRepositoryName(s, `Repo${cmd.replace(/[^A-Za-z]/g, '')}`, 'llmar-console-test'), { cmd: [cmd] }) })
  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app))
  return { app, template: Template.fromStack(stack) }
}
type Res = { Type: string; Properties?: Record<string, any>; DependsOn?: string | string[] }
const resourcesOf = (t: Template) => t.toJSON().Resources as Record<string, Res>
const ofType = (t: Template, type: string) => Object.entries(resourcesOf(t)).filter(([, r]) => r.Type === type)
const first = build(settings())
const full = build(settings({ adminEmail: 'admin@example.com', ingest: 'true', consoleBundle: 'true', consoleBundleDir: 'infra/test-fixtures/console-bundle' }))
const policyOf = (t: Template, role: string) => {
  const p = ofType(t, 'AWS::IAM::Policy').find(([, r]) => JSON.stringify(r.Properties?.Roles).includes(role))
  return (p?.[1].Properties?.PolicyDocument.Statement ?? []) as Array<{ Sid: string; Action: string | string[]; Resource: unknown; Condition?: unknown }>
}
const actions = (stmts: ReturnType<typeof policyOf>) => stmts.flatMap((s) => [s.Action].flat())

describe('console settings', () => {
  it('defaults: no bundle, no ingest, no seed; budgets on; 90-day records', () => {
    expect(settings()).toMatchObject({ prefix: 'llmar', consoleBundle: false, ingest: false, budgets: true, recordRetentionDays: 90, apiThrottle: { rate: 20, burst: 40 } })
    expect(settings().adminEmail).toBeUndefined()
  })
  it('refuses bad values', () => {
    for (const c of <Array<Record<string, string>>>[{ adminEmail: 'not-an-email' }, { ingest: 'maybe' }, { recordRetentionDays: '0' }, { budgets: 'yes' }, { consoleBundleDir: '../outside' }, { consoleThrottle: 'x' }]) {
      expect(() => settings(c), JSON.stringify(c)).toThrow(/invalid deploy settings/)
    }
  })
})

describe('console stack', () => {
  it('passes cdk-nag AwsSolutions with only the justified acknowledgements (first deploy and full)', () => {
    expect(() => build(settings(), true).app.synth()).not.toThrow()
    expect(() => build(settings({ adminEmail: 'admin@example.com', ingest: 'true', consoleBundle: 'true', consoleBundleDir: 'infra/test-fixtures/console-bundle' }), true).app.synth()).not.toThrow()
  })

  it('first deploy (gates off): no bundle upload, no subscription filter, no seed; the origin starts empty', () => {
    expect(ofType(first.template, 'Custom::CDKBucketDeployment')).toHaveLength(0)
    expect(ofType(first.template, 'AWS::Logs::SubscriptionFilter')).toHaveLength(0)
    expect(ofType(first.template, 'Custom::SeedAdmin')).toHaveLength(0)
    expect(ofType(full.template, 'Custom::CDKBucketDeployment')).toHaveLength(1)
    expect(ofType(full.template, 'Custom::SeedAdmin')).toHaveLength(1)
    const [, sub] = ofType(full.template, 'AWS::Logs::SubscriptionFilter')[0] as [string, Res]
    expect(sub.Properties?.FilterPattern).toBe(INGEST_FILTER)
    expect(JSON.stringify(sub.Properties?.LogGroupName)).toContain('routerloggroupname')
  })

  it('site bucket: Block Public Access on, SSE, TLS only; the only reader is CloudFront (OAC) for this distribution', () => {
    const [, b] = ofType(first.template, 'AWS::S3::Bucket')[0] as [string, Res]
    expect(b.Properties?.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true })
    expect(b.Properties?.BucketEncryption).toBeDefined()
    const stmts = ofType(first.template, 'AWS::S3::BucketPolicy').flatMap(([, p]) => p.Properties?.PolicyDocument.Statement as Array<Record<string, any>>)
    for (const s of stmts.filter((x) => x.Effect === 'Allow')) {
      const reader = s.Principal?.Service === 'cloudfront.amazonaws.com'
      const cleanup = JSON.stringify(s.Principal).includes('CustomS3AutoDeleteObjects')
      expect(reader || cleanup, JSON.stringify(s)).toBe(true)
      if (reader) expect(JSON.stringify(s.Condition)).toContain('AWS:SourceArn')
      expect(s.Principal).not.toBe('*')
    }
    expect(stmts.some((s) => s.Effect === 'Deny' && JSON.stringify(s.Condition).includes('aws:SecureTransport'))).toBe(true)
  })

  it('API: one route, gated by the JWT authorizer with the console scope; no $default route; no Lambda URLs', () => {
    const routes = ofType(first.template, 'AWS::ApiGatewayV2::Route')
    expect(routes).toHaveLength(1)
    const [, r] = routes[0] as [string, Res]
    expect(r.Properties?.RouteKey).toBe('ANY /api/{proxy+}')
    expect(r.Properties?.AuthorizationType).toBe('JWT')
    expect(r.Properties?.AuthorizationScopes).toEqual(['llmar/console'])
    const [, a] = ofType(first.template, 'AWS::ApiGatewayV2::Authorizer')[0] as [string, Res]
    expect(a.Properties?.AuthorizerType).toBe('JWT')
    expect(JSON.stringify(a.Properties?.JwtConfiguration.Issuer)).toContain('cognito-idp.')
    expect(JSON.stringify(a.Properties?.JwtConfiguration.Audience)).toContain('ConsoleClient')
    expect(ofType(first.template, 'AWS::Lambda::Url')).toHaveLength(0)
    const [, st] = ofType(first.template, 'AWS::ApiGatewayV2::Stage')[0] as [string, Res]
    expect(st.Properties?.AccessLogSettings.Format).not.toMatch(/claims|header|querystring/i)
    expect(st.Properties?.DefaultRouteSettings).toMatchObject({ ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 })
  })

  it('CloudFront: /api/* uncached with all viewer headers but Host; no distribution-wide error pages; SPA rewrite on the default behavior only', () => {
    const [, d] = ofType(first.template, 'AWS::CloudFront::Distribution')[0] as [string, Res]
    const dc = d.Properties?.DistributionConfig
    expect(dc.CustomErrorResponses).toBeUndefined()
    const api = dc.CacheBehaviors.find((b: Record<string, unknown>) => b.PathPattern === '/api/*')
    expect(api.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad') // Managed-CachingDisabled
    expect(api.OriginRequestPolicyId).toBe('b689b0a8-53d0-40ab-baf2-68738e2966ac') // Managed-AllViewerExceptHostHeader
    expect(api.ViewerProtocolPolicy).toBe('https-only')
    expect(api.FunctionAssociations).toBeUndefined()
    expect(dc.DefaultCacheBehavior.FunctionAssociations).toHaveLength(1)
    expect(dc.ViewerCertificate?.MinimumProtocolVersion ?? 'TLSv1.2_2021').toBe('TLSv1.2_2021')
  })

  it('SPA rewrite keeps files and rewrites routes; CSP is same-origin plus the pool issuer and managed login', () => {
    const run = new Function(`${SPA_REWRITE}; return handler`)() as (e: { request: { uri: string } }) => { uri: string }
    expect(run({ request: { uri: '/members/42' } }).uri).toBe('/index.html')
    expect(run({ request: { uri: '/assets/app-1a2b.js' } }).uri).toBe('/assets/app-1a2b.js')
    const csp = contentSecurityPolicy('ap-southeast-1', 'https://x.auth.ap-southeast-1.amazoncognito.com')
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain('connect-src \'self\' https://cognito-idp.ap-southeast-1.amazonaws.com https://x.auth.ap-southeast-1.amazoncognito.com')
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/)
  })

  it('console client: auth code + PKCE, no secret, console scope only (never invoke), callback on the distribution, branding', () => {
    const [, c] = ofType(first.template, 'AWS::Cognito::UserPoolClient')[0] as [string, Res]
    expect(c.Properties).toMatchObject({ GenerateSecret: false, AllowedOAuthFlows: ['code'], AccessTokenValidity: 15, EnableTokenRevocation: true })
    expect(c.Properties?.AllowedOAuthScopes).toEqual(['openid', 'email', 'llmar/console'])
    // Exactly what the SPA sends (console-web auth/user-manager.ts CALLBACK_PATH / SIGNED_OUT_PATH): Cognito matches exactly.
    const urls = (v: unknown) => JSON.stringify(v)
    expect(urls(c.Properties?.CallbackURLs)).toContain('DomainName')
    expect(urls(c.Properties?.CallbackURLs)).toMatch(/"\/auth\/callback"\]/)
    expect(urls(c.Properties?.LogoutURLs)).toMatch(/"\/signed-out"\]/)
    expect(c.Properties?.CallbackURLs).toHaveLength(1)
    expect(c.Properties?.LogoutURLs).toHaveLength(1)
    expect(ofType(first.template, 'AWS::Cognito::ManagedLoginBranding')).toHaveLength(1)
    expect(ofType(first.template, 'AWS::Cognito::UserPoolGroup').map(([, g]) => g.Properties?.GroupName).sort()).toEqual(['admin', 'member'])
  })

  it('Cognito: every client with refresh token rotation sets no explicit auth flows (first deploy and full)', () => {
    for (const t of [first.template, full.template]) {
      const rotating = ofType(t, 'AWS::Cognito::UserPoolClient').filter(([, c]) => c.Properties?.RefreshTokenRotation?.Feature === 'ENABLED')
      expect(rotating.length).toBeGreaterThan(0)
      for (const [id, c] of rotating) expect(c.Properties?.ExplicitAuthFlows ?? [], id).toEqual([])
    }
  })

  it('reads RouterStack values from SSM parameters (no cross-stack exports)', () => {
    const params = Object.values((first.template.toJSON().Parameters ?? {}) as Record<string, { Default?: string }>).map((p) => p.Default)
    expect(params).toContain(routerParamName('llmar', 'userPoolId'))
    expect(params).toContain(routerParamName('llmar', 'configBucket'))
    expect(JSON.stringify(first.template.toJSON())).not.toContain('Fn::ImportValue')
  })

  it('tables: pk/sk; console PITR on; usage TTL and two GSIs; both destroyable', () => {
    const tables = Object.fromEntries(ofType(first.template, 'AWS::DynamoDB::Table').map(([, t]) => [t.Properties?.TableName, t]))
    expect(tables['llmar-console']?.Properties?.PointInTimeRecoverySpecification).toEqual({ PointInTimeRecoveryEnabled: true })
    expect(tables['llmar-usage']?.Properties?.TimeToLiveSpecification).toEqual({ AttributeName: 'ttl', Enabled: true })
    expect(tables['llmar-usage']?.Properties?.GlobalSecondaryIndexes.map((g: { IndexName: string }) => g.IndexName)).toEqual(['gsi1', 'gsi2'])
    for (const t of Object.values(tables) as Res[]) expect(t.Properties?.DeletionProtectionEnabled ?? false).toBe(false)
  })

  it('least privilege: console-api never invokes models, updates the gateway or pool clients, or touches IAM; ingest reads only MEMBER#*/CONFIG', () => {
    const api = actions(policyOf(full.template, 'consoleapiRole'))
    for (const bad of ['bedrock:InvokeModel', 'bedrock-agentcore:UpdateGateway', 'bedrock-agentcore:UpdateGatewayTarget', 'cognito-idp:UpdateUserPoolClient', 'cognito-idp:AdminResetUserPassword', 's3:DeleteObject',
      // no caller in console-api (73): trimmed
      'cognito-idp:AdminListGroupsForUser', 'cognito-idp:DescribeUserPoolClient', 'cognito-idp:ListUserPoolClients', 'bedrock-agentcore:GetGatewayRule',
      // MFA is off (deployer decision): the console no longer resets member MFA
      'cognito-idp:AdminSetUserMFAPreference']) {
      expect(api).not.toContain(bad)
    }
    expect(api.some((a) => a.startsWith('iam:') || a === '*' || a.endsWith(':*'))).toBe(false)
    // The baked document (RouterStack's config/baked.json + config/baked/<version>.json): read only.
    const baked = policyOf(full.template, 'consoleapiRole').find((s) => s.Sid === 'BakedConfigRead')
    expect(baked?.Action).toBe('s3:GetObject')
    expect(JSON.stringify(baked?.Resource)).toMatch(/\/config\/baked\.json".*\/config\/baked\/\*"/)
    const ingest = policyOf(full.template, 'usageingestRole')
    const consoleRead = ingest.find((s) => s.Sid === 'ConsoleReadBudgetsAndConfig')
    expect(consoleRead?.Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['MEMBER#*', 'CONFIG'] } })
    expect(actions(ingest).some((a) => a.startsWith('cognito-idp:'))).toBe(false)
    const s3 = ingest.filter((s) => [s.Action].flat().some((a) => a.startsWith('s3:Get') || a.startsWith('s3:Put')))
    expect(JSON.stringify(s3.map((s) => s.Resource))).toMatch(/identity\/budget-blocks\.json/)
    expect(JSON.stringify(s3.map((s) => s.Resource))).not.toMatch(/identity\/blocks\.json|principals|\/config\//)
    const seed = policyOf(full.template, 'seedadminRole')
    expect(actions(seed).sort()).toEqual(['cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminCreateUser', 'cognito-idp:ListUsers',
      'dynamodb:GetItem', 'dynamodb:PutItem', 'logs:CreateLogStream', 'logs:PutLogEvents'])
  })

  it('Lambdas: ARM64 images with the three handler CMDs; ingest retries twice then goes to the DLQ', () => {
    const fns = ofType(full.template, 'AWS::Lambda::Function').filter(([, f]) => f.Properties?.PackageType === 'Image')
    expect(fns.map(([, f]) => f.Properties?.ImageConfig.Command[0]).sort()).toEqual(Object.values(LAMBDA_CMD).sort())
    for (const [, f] of fns) expect(f.Properties?.Architectures).toEqual(['arm64'])
    const [, eic] = ofType(full.template, 'AWS::Lambda::EventInvokeConfig')[0] as [string, Res]
    expect(eic.Properties).toMatchObject({ MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 21_600 })
    expect(JSON.stringify(eic.Properties?.DestinationConfig)).toContain('IngestDlq')
    const ingest = fns.find(([, f]) => f.Properties?.ImageConfig.Command[0] === LAMBDA_CMD.ingest)?.[1]
    expect(Object.keys(ingest?.Properties?.Environment.Variables).sort()).toEqual(['BUDGETS', 'CATALOG_REGION', 'CONFIG_BUCKET', 'CONSOLE_TABLE', 'NODE_OPTIONS', 'RECORD_RETENTION_DAYS', 'USAGE_TABLE'])
    const api = fns.find(([, f]) => f.Properties?.ImageConfig.Command[0] === LAMBDA_CMD.consoleApi)?.[1]
    expect(api?.Properties?.Environment.Variables).toMatchObject({ RECORD_RETENTION_DAYS: '90' })
    expect(JSON.stringify(api?.Properties?.Environment.Variables.RESERVED_CLIENT_IDS)).toContain('agentclientid')
  })

  it('/config.json is exactly what the SPA accepts: the synthesized file passes console-web parseRuntimeConfig', () => {
    const fullBuild = build(settings({ adminEmail: 'admin@example.com', consoleBundle: 'true', consoleBundleDir: 'infra/test-fixtures/console-bundle' }))
    const out = fullBuild.app.synth().directory
    const files = readdirSync(out).filter((d) => d.startsWith('asset.') && existsSync(join(out, d, SPA_CONFIG_KEY)))
      .map((d) => readFileSync(join(out, d, SPA_CONFIG_KEY), 'utf8'))
    expect(files).toHaveLength(1)
    // Deploy-time values are markers in the staged file, resolved by the deployment from SourceMarkers: substitute
    // deterministic placeholders of the deployed shape for each CloudFormation expression.
    const [, dep] = ofType(fullBuild.template, 'Custom::CDKBucketDeployment')[0] as [string, Res]
    const placeholder = (e: unknown): string => {
      if (typeof e === 'string') return e
      const o = e as Record<string, any>
      if (o['Fn::Join']) return (o['Fn::Join'][1] as unknown[]).map(placeholder).join(o['Fn::Join'][0])
      if (o.Ref === 'AWS::Region') return 'ap-southeast-1'
      if (typeof o.Ref === 'string' && /cognitodomain/i.test(o.Ref)) return 'https://llmar-abc123.auth.ap-southeast-1.amazoncognito.com'
      if (typeof o.Ref === 'string' && /userpoolid/i.test(o.Ref)) return 'ap-southeast-1_TESTPOOL'
      if (o.Ref === 'ConsoleClient') return 'consoleclient0000000000000'
      throw new Error(`unexpected marker expression ${JSON.stringify(o)}`)
    }
    const markers = (dep.Properties?.SourceMarkers as Array<Record<string, unknown>>).find((m) => Object.keys(m).length > 0) ?? {}
    let text = files[0] as string
    for (const [marker, expr] of Object.entries(markers)) text = text.split(marker).join(placeholder(expr))
    expect(text).not.toMatch(/<<marker:/)
    const raw = JSON.parse(text) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['apiBase', 'clientId', 'cognitoDomain', 'issuer', 'region', 'schemaVersion', 'scopes', 'tokenStorage'])
    expect(parseRuntimeConfig(raw)).toEqual({ schemaVersion: 1, region: 'ap-southeast-1', issuer: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_TESTPOOL',
      cognitoDomain: 'https://llmar-abc123.auth.ap-southeast-1.amazoncognito.com', clientId: 'consoleclient0000000000000',
      scopes: ['openid', 'email', 'llmar/console'], apiBase: '/api', tokenStorage: 'session' })
  })

  it('outputs carry no account id', () => {
    expect(JSON.stringify(first.template.toJSON().Outputs)).not.toMatch(/\d{12}/)
  })
})
