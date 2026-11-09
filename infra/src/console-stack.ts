// Admin console stack (admin console design v1 §1, §2.3, §4; a3 research §4). Deployed after RouterStack, destroyed
// before it. It reads RouterStack's values from SSM parameters (ROUTER_PARAMS), never from stack exports.
//
//   browser ─HTTPS─> CloudFront ─┬─ /*     ─OAC─> S3 site bucket (private, BPA on; SPA bundle + config.json, no data)
//                                └─ /api/* ─────> HTTP API (JWT authorizer: pool issuer, console client, <prefix>/console)
//                                                   └─> console-api Lambda ─> DynamoDB console/usage, Cognito admin, S3, …
//   router log group ─subscription (kind model|error|rejected|config)─> usage-ingest Lambda ─> DynamoDB usage (+ SQS DLQ)
//
// Deploy order (builder-security: verify anonymous denial before any restricted content exists):
//   1. consoleBundle=false, ingest=false: the API, tables and an empty site bucket. Run the anonymous-denial checks.
//   2. consoleBundle=true: upload the SPA. 3. ingest=true: the subscription filter, so usage data starts flowing.
import {
  Aws, type CfnElement, CfnOutput, CustomResource, Duration, Fn, IgnoreMode, RemovalPolicy, Stack, type StackProps, Validations,
  aws_apigatewayv2 as apigw, aws_apigatewayv2_authorizers as authorizers, aws_apigatewayv2_integrations as integrations,
  aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_cloudwatch as cw, aws_cognito as cognito,
  aws_dynamodb as ddb, aws_ecr_assets as ecrAssets, aws_iam as iam, aws_lambda as lambda,
  aws_lambda_destinations as destinations, aws_logs as logs, aws_logs_destinations as logsDestinations, aws_s3 as s3,
  aws_s3_deployment as s3deploy, aws_sqs as sqs, aws_ssm as ssm, custom_resources as cr,
} from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import { BAKED_OBJECTS } from './baked.ts'
import { contextReader, resolveCommon, SettingsError, type CommonSettings, type Ctx } from './settings.ts'

const REPO_ROOT = new URL('../../', import.meta.url).pathname

/**
 * RouterStack values the console needs, as SSM String parameters under `/<prefix>/router/` (written by RouterStack).
 * Resolved at deploy time (CloudFormation parameters), so neither stack locks the other with exports.
 */
export const ROUTER_PARAMS = {
  userPoolId: 'user-pool-id', userPoolArn: 'user-pool-arn', cognitoDomain: 'cognito-domain',
  gatewayId: 'gateway-id', gatewayUrl: 'gateway-url', configBucket: 'config-bucket', logGroupName: 'log-group-name',
  clusterName: 'cluster-name', serviceName: 'service-name', serviceArn: 'service-arn', cliClientId: 'cli-client-id', agentClientId: 'agent-client-id',
  callbackPorts: 'cli-callback-ports', codexOauthPort: 'codex-oauth-port', modelUniverse: 'model-universe', identityHeader: 'identity-header',
} as const
export type RouterParam = keyof typeof ROUTER_PARAMS
export const routerParamName = (prefix: string, p: RouterParam): string => `/${prefix}/router/${ROUTER_PARAMS[p]}`

/** Router log lines the usage ingest reads (design v1 §2.3): request lines and config activations, never EMF documents. */
export const INGEST_FILTER = '{ ($.kind = "model") || ($.kind = "error") || ($.kind = "rejected") || ($.kind = "config") }'
/** The SPA's runtime settings file, written next to the bundle (no secrets: public client ids and URLs only). */
export const SPA_CONFIG_KEY = 'config.json'
export const GROUPS = ['admin', 'member'] as const

/**
 * /config.json in exactly the SPA's schema (console-web config/runtime-config.ts parseRuntimeConfig; the contract test
 * runs the synthesized file through it). The SPA derives the redirect URIs from its own origin (auth/user-manager.ts).
 */
export function spaRuntimeConfig(v: { region: string; issuer: string; cognitoDomain: string; clientId: string; consoleScope: string }) {
  return { schemaVersion: 1, region: v.region, issuer: v.issuer, cognitoDomain: v.cognitoDomain, clientId: v.clientId,
    scopes: ['openid', 'email', v.consoleScope], apiBase: '/api', tokenStorage: 'session' }
}

/**
 * Lambda entry points (packages/console-api, packages/usage-ingest): image CMDs in infra/lambda/Dockerfile.
 * The image is built from the repository root and runs the TypeScript sources with Node 24 type stripping.
 */
export const LAMBDA_CMD = { consoleApi: 'handlers/console-api.handler', ingest: 'handlers/usage-ingest.handler', seedAdmin: 'handlers/seed-admin.handler' } as const

export interface ConsoleSettings extends CommonSettings {
  /** Upload the SPA (step 2). Off on the first deploy so the anonymous checks run against an empty origin. */
  consoleBundle: boolean
  /** Built SPA directory (relative to the repository root), uploaded when consoleBundle is on. */
  consoleBundleDir: string
  /** Subscribe usage-ingest to the router log group (step 3). */
  ingest: boolean
  /** E-mail of the first admin (invited by the seed custom resource); without it nobody can sign in. */
  adminEmail?: string
  recordRetentionDays: number
  budgets: boolean
  /** HTTP API stage throttling. */
  apiThrottle: { rate: number; burst: number }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/

/**
 * Console context keys: the common ones (region, account, prefix, tags), consoleBundle, consoleBundleDir, ingest,
 * adminEmail, recordRetentionDays (default 90), budgets (on|off, default on), consoleThrottle ('<rate>,<burst>',
 * default 20,40).
 */
export function resolveConsoleSettings(node: Ctx, env: NodeJS.ProcessEnv): ConsoleSettings {
  const issues: string[] = []
  const str = contextReader(node)
  const common = resolveCommon(str, env, { Project: 'llm-auto-router', Purpose: 'console' }, issues)
  const flag = (k: string, dflt: boolean): boolean => {
    const v = str(k)
    if (v === undefined) return dflt
    if (['true', '1', 'on'].includes(v)) return true
    if (['false', '0', 'off'].includes(v)) return false
    issues.push(`${k}: true | false`)
    return dflt
  }
  const adminEmail = str('adminEmail')
  if (adminEmail !== undefined && !EMAIL_RE.test(adminEmail)) issues.push('adminEmail: e-mail address required')
  const retention = Number(str('recordRetentionDays') ?? '90')
  if (!Number.isInteger(retention) || retention < 1 || retention > 3650) issues.push('recordRetentionDays: integer 1..3650')
  const budgets = str('budgets') ?? 'on'
  if (budgets !== 'on' && budgets !== 'off') issues.push('budgets: on | off')
  const [rate, burst] = (str('consoleThrottle') ?? '20,40').split(',').map((x) => Number(x.trim()))
  if (!Number.isFinite(rate) || !Number.isInteger(burst) || (rate as number) <= 0 || (burst as number) <= 0) issues.push('consoleThrottle: <rate>,<burst>')
  const consoleBundleDir = str('consoleBundleDir') ?? 'packages/console-web/dist'
  if (consoleBundleDir.startsWith('/') || consoleBundleDir.includes('..')) issues.push('consoleBundleDir: a path inside the repository')
  const consoleBundle = flag('consoleBundle', false)
  const ingest = flag('ingest', false)
  if (issues.length) throw new SettingsError(issues)
  return {
    ...common, consoleBundle, consoleBundleDir, ingest,
    ...(adminEmail ? { adminEmail } : {}), recordRetentionDays: retention, budgets: budgets === 'on',
    apiThrottle: { rate: rate as number, burst: burst as number },
  }
}

/** Strict CSP for the SPA: same origin plus the pool's issuer and managed-login domain (oidc-client-ts discovery and token). */
export function contentSecurityPolicy(region: string, cognitoDomain: string): string {
  return [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self' data:",
    `connect-src 'self' https://cognito-idp.${region}.amazonaws.com ${cognitoDomain}`, `form-action 'self' ${cognitoDomain}`,
    "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'",
  ].join('; ')
}

/** SPA routing without distribution-wide error responses (those would also rewrite /api/* 401/403/404 into index.html). */
export const SPA_REWRITE = `function handler(event) {
  var r = event.request;
  if (!/\\.[A-Za-z0-9]{1,8}$/.test(r.uri)) { r.uri = '/index.html'; }
  return r;
}`

export interface ConsoleStackProps extends StackProps {
  settings: ConsoleSettings
  /** Lambda code for an image CMD; defaults to the repository image (infra/lambda/Dockerfile). Tests inject a registry image. */
  code?: (scope: Construct, cmd: string) => lambda.DockerImageCode
}

export class ConsoleStack extends Stack {
  constructor(scope: Construct, id: string, props: ConsoleStackProps) {
    super(scope, id, props)
    const cfg = props.settings
    const n = (x: string) => `${cfg.prefix}-${x}`
    const ack = (c: Construct, id: string, reason: string) => Validations.of(c).acknowledge({ id, reason })
    const param = (p: RouterParam) => ssm.StringParameter.valueForStringParameter(this, routerParamName(cfg.prefix, p))
    const poolId = param('userPoolId')
    const poolArn = param('userPoolArn')
    const cognitoDomain = param('cognitoDomain')
    const configBucket = param('configBucket')
    const gatewayArn = `arn:aws:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:gateway/${param('gatewayId')}`
    const consoleScope = `${cfg.prefix}/console`
    const issuer = `https://cognito-idp.${Aws.REGION}.amazonaws.com/${poolId}`
    const code = props.code ?? ((_: Construct, cmd: string) => lambda.DockerImageCode.fromImageAsset(REPO_ROOT, {
      file: 'infra/lambda/Dockerfile', cmd: [cmd], platform: ecrAssets.Platform.LINUX_ARM64, ignoreMode: IgnoreMode.DOCKER,
      exclude: ['**', '!package.json', '!pnpm-lock.yaml', '!pnpm-workspace.yaml', '!tsconfig.base.json', '!infra/lambda/**',
        ...['pricing', 'core', 'assessor', 'router', 'console-contract', 'console-api', 'usage-ingest'].flatMap((p) =>
          [`!packages/${p}/package.json`, `!packages/${p}/src/**`]), '!packages/assessor/prompts/**', '**/node_modules'],
    }))

    // ---------------------------------------------------------------- tables
    const consoleTable = new ddb.Table(this, 'ConsoleTable', {
      tableName: n('console'), partitionKey: { name: 'pk', type: ddb.AttributeType.STRING }, sortKey: { name: 'sk', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST, pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.DESTROY, deletionProtection: false,
    })
    const usageTable = new ddb.Table(this, 'UsageTable', {
      tableName: n('usage'), partitionKey: { name: 'pk', type: ddb.AttributeType.STRING }, sortKey: { name: 'sk', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST, timeToLiveAttribute: 'ttl', removalPolicy: RemovalPolicy.DESTROY, deletionProtection: false,
    })
    for (const g of ['gsi1', 'gsi2']) {
      usageTable.addGlobalSecondaryIndex({ indexName: g, partitionKey: { name: `${g}pk`, type: ddb.AttributeType.STRING },
        sortKey: { name: `${g}sk`, type: ddb.AttributeType.STRING }, projectionType: ddb.ProjectionType.ALL })
    }

    // ---------------------------------------------------------------- site bucket + CloudFront (OAC); API behind /api/*
    const site = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED, versioned: false, removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    })

    // Console app client (auth code + PKCE, no secret). It lives here, not in RouterStack: its callback URL is this
    // distribution's domain. RouterStack's resource server must define the `console` scope.
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'Headers', {
      responseHeadersPolicyName: n('console-headers'),
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(730), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
        contentSecurityPolicy: { contentSecurityPolicy: contentSecurityPolicy(Aws.REGION, cognitoDomain), override: true },
      },
    })
    const rewrite = new cloudfront.Function(this, 'SpaRewrite', {
      functionName: n('console-spa-rewrite'), runtime: cloudfront.FunctionRuntime.JS_2_0, code: cloudfront.FunctionCode.fromInline(SPA_REWRITE),
    })

    // ---------------------------------------------------------------- Lambdas
    const fnLogs = (name: string) => new logs.LogGroup(this, `${name}Logs`, {
      logGroupName: `/aws/lambda/${n(name)}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    const role = (name: string, group: logs.LogGroup) => {
      const r = new iam.Role(this, `${name}Role`, { roleName: n(`${name}-role`), assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } } }) })
      r.addToPolicy(new iam.PolicyStatement({ sid: 'OwnLogs', actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${group.logGroupArn}:*`] }))
      return r
    }
    const fn = (name: string, cmd: string, r: iam.Role, group: logs.LogGroup, o: { memory: number; timeout: Duration; env: Record<string, string> }) =>
      new lambda.DockerImageFunction(this, name, {
        functionName: n(name), code: code(this, cmd), architecture: lambda.Architecture.ARM_64, role: r, logGroup: group,
        memorySize: o.memory, timeout: o.timeout, environment: { NODE_OPTIONS: '--enable-source-maps', ...o.env },
      })
    const ddbItems = (t: ddb.Table, withIndexes = false) => [t.tableArn, ...(withIndexes ? [`${t.tableArn}/index/*`] : [])]
    const objectArn = (key: string) => `arn:aws:s3:::${configBucket}/${key}`
    const bucketArn = `arn:aws:s3:::${configBucket}`

    // console-api: one handler for every route (packages/console-api); authorization per route inside. Config activation is one
    // TransactWriteItems (IAM evaluates its per-item Put/Update/ConditionCheck actions).
    const apiLogs = fnLogs('console-api')
    const apiRole = role('console-api', apiLogs)
    apiRole.addToPolicy(new iam.PolicyStatement({ sid: 'ConsoleTable', resources: ddbItems(consoleTable),
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:BatchGetItem', 'dynamodb:ConditionCheckItem'] }))
    apiRole.addToPolicy(new iam.PolicyStatement({ sid: 'UsageRead', resources: ddbItems(usageTable, true), actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:BatchGetItem'] }))
    apiRole.addToPolicy(new iam.PolicyStatement({ sid: 'ConfigObjects', actions: ['s3:GetObject', 's3:PutObject'],
      resources: ['config/active.json', 'config/versions/*', 'identity/blocks.json', 'identity/principals.json'].map(objectArn) }))
    apiRole.addToPolicy(new iam.PolicyStatement({ sid: 'PacksRead', actions: ['s3:GetObject'], resources: [objectArn('packs/*')] }))
    // The baked document (config/baked.json + config/baked/<version>.json, RouterStack): effective settings per section.
    apiRole.addToPolicy(new iam.PolicyStatement({ sid: 'BakedConfigRead', actions: ['s3:GetObject'], resources: BAKED_OBJECTS.map(objectArn) }))
    // ListBucket turns a missing key into 404 (absent) instead of 403. An s3:prefix condition would not apply to that
    // check on GetObject, so it is unconditioned: the bucket holds only control-plane objects.
    apiRole.addToPolicy(new iam.PolicyStatement({ sid: 'ListConfigBucket', actions: ['s3:ListBucket'], resources: [bucketArn] }))
    apiRole.addToPolicy(new iam.PolicyStatement({ sid: 'Members', resources: [poolArn], actions: [
      'cognito-idp:AdminCreateUser', 'cognito-idp:AdminGetUser', 'cognito-idp:AdminDisableUser', 'cognito-idp:AdminEnableUser',
      'cognito-idp:AdminDeleteUser', 'cognito-idp:AdminUserGlobalSignOut',
      'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminRemoveUserFromGroup',
      'cognito-idp:ListUsers', 'cognito-idp:ListUsersInGroup'] }))
    // Service clients (R7). No UpdateUserPoolClient: it could add callback URLs to the cli/console clients. The adapter refuses any
    // client without a console-created MEMBER#client:<id> item, so agent/cli/console are never touched (IAM cannot express that).
    apiRole.addToPolicy(new iam.PolicyStatement({ sid: 'ServiceClients', resources: [poolArn], actions: [
      'cognito-idp:CreateUserPoolClient', 'cognito-idp:DeleteUserPoolClient',
      'cognito-idp:AddUserPoolClientSecret', 'cognito-idp:DeleteUserPoolClientSecret', 'cognito-idp:ListUserPoolClientSecrets'] }))
    apiRole.addToPolicy(new iam.PolicyStatement({ sid: 'GatewayRead', resources: [gatewayArn, `${gatewayArn}/*`], actions: [
      'bedrock-agentcore:GetGateway', 'bedrock-agentcore:ListGatewayTargets', 'bedrock-agentcore:GetGatewayTarget',
      'bedrock-agentcore:ListGatewayRules'] }))
    apiRole.addToPolicy(new iam.PolicyStatement({ sid: 'RouterService', actions: ['ecs:DescribeServices'], resources: [param('serviceArn')] }))
    apiRole.addToPolicy(new iam.PolicyStatement({ sid: 'Metrics', actions: ['cloudwatch:GetMetricData', 'cloudwatch:DescribeAlarms'], resources: ['*'] }))
    const apiFn = fn('console-api', LAMBDA_CMD.consoleApi, apiRole, apiLogs, { memory: 512, timeout: Duration.seconds(29), env: {
      CONSOLE_TABLE: consoleTable.tableName, USAGE_TABLE: usageTable.tableName, CONFIG_BUCKET: configBucket, USER_POOL_ID: poolId,
      PREFIX: cfg.prefix, CONSOLE_SCOPE: consoleScope, INVOKE_SCOPE: `${cfg.prefix}/invoke`, RESOURCE_SERVER_ID: cfg.prefix,
      GATEWAY_ID: param('gatewayId'), GATEWAY_URL: param('gatewayUrl'), INFERENCE_URL: `${param('gatewayUrl')}/inference`,
      COGNITO_DOMAIN: cognitoDomain, CLI_CLIENT_ID: param('cliClientId'), CALLBACK_PORTS: param('callbackPorts'), CODEX_OAUTH_PORT: param('codexOauthPort'),
      IDENTITY_HEADER: param('identityHeader'), MODEL_UNIVERSE: param('modelUniverse'), CATALOG_REGION: cfg.region,
      ROUTER_CLUSTER: param('clusterName'), ROUTER_SERVICE: param('serviceName'), ROUTER_LOG_GROUP: param('logGroupName'),
      METRICS_NAMESPACE: 'LlmAutoRouter', REFRESH_DAYS: '30', RECORD_RETENTION_DAYS: String(cfg.recordRetentionDays),
    } })

    // usage-ingest (packages/usage-ingest): asynchronous invokes from the subscription; failures go to the DLQ.
    const ingestLogs = fnLogs('usage-ingest')
    const ingestRole = role('usage-ingest', ingestLogs)
    ingestRole.addToPolicy(new iam.PolicyStatement({ sid: 'UsageWrite', resources: ddbItems(usageTable),
      actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem', 'dynamodb:GetItem', 'dynamodb:BatchGetItem'] }))
    ingestRole.addToPolicy(new iam.PolicyStatement({ sid: 'ConsoleReadBudgetsAndConfig', resources: ddbItems(consoleTable),
      actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem'],
      conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['MEMBER#*', 'CONFIG'] } } }))
    ingestRole.addToPolicy(new iam.PolicyStatement({ sid: 'BudgetBlocks', actions: ['s3:GetObject', 's3:PutObject'], resources: [objectArn('identity/budget-blocks.json')] }))
    ingestRole.addToPolicy(new iam.PolicyStatement({ sid: 'ListConfigBucket', actions: ['s3:ListBucket'], resources: [bucketArn] }))
    const dlq = new sqs.Queue(this, 'IngestDlq', {
      queueName: n('usage-ingest-dlq'), enforceSSL: true, encryption: sqs.QueueEncryption.SQS_MANAGED, retentionPeriod: Duration.days(14),
    })
    const ingestFn = fn('usage-ingest', LAMBDA_CMD.ingest, ingestRole, ingestLogs, { memory: 256, timeout: Duration.seconds(60), env: {
      USAGE_TABLE: usageTable.tableName, CONSOLE_TABLE: consoleTable.tableName, CONFIG_BUCKET: configBucket, CATALOG_REGION: cfg.region,
      RECORD_RETENTION_DAYS: String(cfg.recordRetentionDays), BUDGETS: cfg.budgets ? 'on' : 'off',
    } })
    ingestFn.configureAsyncInvoke({ retryAttempts: 2, maxEventAge: Duration.hours(6), onFailure: new destinations.SqsDestination(dlq) })
    if (cfg.ingest) {
      const routerLogs = logs.LogGroup.fromLogGroupName(this, 'RouterLogs', param('logGroupName'))
      new logs.SubscriptionFilter(this, 'IngestSubscription', {
        logGroup: routerLogs, destination: new logsDestinations.LambdaDestination(ingestFn), filterPattern: logs.FilterPattern.literal(INGEST_FILTER),
        filterName: n('usage-ingest'),
      })
    }
    new cw.Alarm(this, 'IngestDlqNotEmpty', { alarmName: n('usage-ingest-dlq'), metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 0, comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING })
    for (const [id, f] of [['IngestErrors', ingestFn], ['ConsoleApiErrors', apiFn]] as const) {
      new cw.Alarm(this, id, { alarmName: n(id === 'IngestErrors' ? 'usage-ingest-errors' : 'console-api-errors'), metric: f.metricErrors({ period: Duration.minutes(5) }),
        threshold: 0, comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD, evaluationPeriods: 1, treatMissingData: cw.TreatMissingData.NOT_BREACHING })
    }

    // ---------------------------------------------------------------- HTTP API: one gated proxy route, no $default
    const apiAccessLogs = new logs.LogGroup(this, 'ApiAccessLogs', { logGroupName: `/${cfg.prefix}/console-api-access`,
      retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    const httpApi = new apigw.HttpApi(this, 'Api', { apiName: n('console-api'), createDefaultStage: false, disableExecuteApiEndpoint: false })
    const stage = new apigw.HttpStage(this, 'ApiStage', { httpApi, stageName: '$default', autoDeploy: true,
      throttle: { rateLimit: cfg.apiThrottle.rate, burstLimit: cfg.apiThrottle.burst } })
    // Access log: request metadata only; no headers, no claims, no query strings.
    ;(stage.node.defaultChild as apigw.CfnStage).accessLogSettings = { destinationArn: apiAccessLogs.logGroupArn, format: JSON.stringify({
      requestId: '$context.requestId', routeKey: '$context.routeKey', status: '$context.status', protocol: '$context.protocol',
      responseLength: '$context.responseLength', latency: '$context.responseLatency', authorizerError: '$context.authorizer.error',
      integrationError: '$context.integrationErrorMessage', requestTime: '$context.requestTimeEpoch' }) }

    // ---------------------------------------------------------------- Cognito: console client, groups
    const consoleClient = new cognito.CfnUserPoolClient(this, 'ConsoleClient', {
      userPoolId: poolId, clientName: n('console'), generateSecret: false, allowedOAuthFlowsUserPoolClient: true,
      allowedOAuthFlows: ['code'], allowedOAuthScopes: ['openid', 'email', consoleScope], supportedIdentityProviders: ['COGNITO'],
      // No explicitAuthFlows (like the cli client): the SPA refreshes through /oauth2/token, and Cognito refuses
      // ALLOW_REFRESH_TOKEN_AUTH on a client with refresh token rotation (create fails with 400 InvalidRequest).
      preventUserExistenceErrors: 'ENABLED', enableTokenRevocation: true,
      accessTokenValidity: 15, idTokenValidity: 15, refreshTokenValidity: 8,
      tokenValidityUnits: { accessToken: 'minutes', idToken: 'minutes', refreshToken: 'hours' },
      refreshTokenRotation: { feature: 'ENABLED', retryGracePeriodSeconds: 10 },
    })
    // App clients the console must never rotate or delete (the cli client is reserved by the adapter itself).
    apiFn.addEnvironment('RESERVED_CLIENT_IDS', Fn.join(',', [param('agentClientId'), consoleClient.ref]))
    new cognito.CfnManagedLoginBranding(this, 'ConsoleBranding', { userPoolId: poolId, clientId: consoleClient.ref, useCognitoProvidedValues: true })
    for (const g of GROUPS) new cognito.CfnUserPoolGroup(this, `Group${g}`, { userPoolId: poolId, groupName: g, description: `console ${g}s` })

    const jwt = new authorizers.HttpJwtAuthorizer('Jwt', issuer, { authorizerName: n('console-jwt'), jwtAudience: [consoleClient.ref],
      identitySource: ['$request.header.Authorization'] })
    httpApi.addRoutes({ path: '/api/{proxy+}', methods: [apigw.HttpMethod.ANY], integration: new integrations.HttpLambdaIntegration('ConsoleApi', apiFn),
      authorizer: jwt, authorizationScopes: [consoleScope] })

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: `${cfg.prefix} admin console`, defaultRootObject: 'index.html', priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021, httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site), viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: headers, functionAssociations: [{ function: rewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(`${httpApi.apiId}.execute-api.${Aws.REGION}.amazonaws.com`, { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY, allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
        },
      },
    })
    const consoleUrl = `https://${distribution.distributionDomainName}`
    // Exactly what the SPA sends (packages/console-web/src/auth/user-manager.ts): Cognito matches redirect URIs exactly.
    consoleClient.callbackUrLs = [`${consoleUrl}/auth/callback`]
    consoleClient.logoutUrLs = [`${consoleUrl}/signed-out`]

    // ---------------------------------------------------------------- first admin (seed custom resource)
    let seedParts: { role: iam.Role; logs: logs.LogGroup; fn: lambda.Function; provider: cr.Provider } | undefined
    if (cfg.adminEmail) {
      const seedLogs = fnLogs('seed-admin')
      const seedRole = role('seed-admin', seedLogs)
      seedRole.addToPolicy(new iam.PolicyStatement({ sid: 'SeedUser', resources: [poolArn], actions: [
        'cognito-idp:AdminCreateUser', 'cognito-idp:AdminAddUserToGroup', 'cognito-idp:ListUsers'] }))
      seedRole.addToPolicy(new iam.PolicyStatement({ sid: 'SeedMember', resources: ddbItems(consoleTable), actions: ['dynamodb:GetItem', 'dynamodb:PutItem'],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['MEMBER#*'] } } }))
      const seedFn = fn('seed-admin', LAMBDA_CMD.seedAdmin, seedRole, seedLogs, { memory: 256, timeout: Duration.seconds(60), env: {
        USER_POOL_ID: poolId, CONSOLE_TABLE: consoleTable.tableName } })
      const provider = new cr.Provider(this, 'SeedProvider', { onEventHandler: seedFn, logGroup: seedLogs })
      seedParts = { role: seedRole, logs: seedLogs, fn: seedFn, provider }
      const seed = new CustomResource(this, 'SeedAdmin', { serviceToken: provider.serviceToken, resourceType: 'Custom::SeedAdmin',
        properties: { email: cfg.adminEmail, group: 'admin' } })
      seed.node.addDependency(this.node.findChild('Groupadmin'))
    }

    // ---------------------------------------------------------------- SPA bundle (step 2)
    if (cfg.consoleBundle) {
      const bundle = new s3deploy.BucketDeployment(this, 'Bundle', {
        destinationBucket: site, distribution, distributionPaths: ['/*'], prune: true, memoryLimit: 512,
        sources: [s3deploy.Source.asset(`${REPO_ROOT}${cfg.consoleBundleDir}`), s3deploy.Source.jsonData(SPA_CONFIG_KEY,
          spaRuntimeConfig({ region: Aws.REGION, issuer, cognitoDomain, clientId: consoleClient.ref, consoleScope }))],
      })
      // The CDK BucketDeployment singleton (a framework Lambda copying the bundle from the CDK asset bucket).
      const handler = this.node.children.find((c) => c.node.id.startsWith('Custom::CDKBucketDeployment'))
      if (handler) {
        const why = 'CDK BucketDeployment framework function: copies the built SPA from the CDK asset bucket into the site bucket and invalidates the distribution.'
        for (const f of ['AwsSolutions-L1', 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
          ...['s3:Abort*', 's3:DeleteObject*', 's3:GetBucket*', 's3:GetObject*', 's3:List*'].map((a) => `AwsSolutions-IAM5[Action::${a}]`),
          'AwsSolutions-IAM5[Resource::*]', `AwsSolutions-IAM5[Resource::<${this.getLogicalId(site.node.defaultChild as CfnElement)}.Arn>/*]`,
          `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-${cfg.account}-${cfg.region}/*]`]) ack(handler, f, why)
      }
      void bundle
    }

    // ---------------------------------------------------------------- outputs (no secrets, no account ids)
    new CfnOutput(this, 'ConsoleUrl', { value: consoleUrl })
    new CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint })
    new CfnOutput(this, 'ConsoleClientId', { value: consoleClient.ref })
    new CfnOutput(this, 'SiteBucketName', { value: site.bucketName })
    new CfnOutput(this, 'ConsoleTableName', { value: consoleTable.tableName })
    new CfnOutput(this, 'UsageTableName', { value: usageTable.tableName })
    new CfnOutput(this, 'IngestDlqUrl', { value: dlq.queueUrl })

    // ---------------------------------------------------------------- cdk-nag acknowledgements (exact findings)
    ack(usageTable, 'AwsSolutions-DDB3', 'Usage records and rollups are derived from the router log group (rebuildable within its retention) and expire by TTL; PITR would back up a cache.')
    ack(site, 'AwsSolutions-S1', 'Static SPA bundle served only through CloudFront OAC; it holds no data, so object-level access logs add nothing.')
    ack(distribution, 'AwsSolutions-CFR1', 'Invited-team console behind Cognito sign-in; no geography restriction is required.')
    ack(distribution, 'AwsSolutions-CFR2', 'WAF is optional (design D1, not deployed): every /api route is gated by the JWT authorizer; the static shell holds no data.')
    ack(distribution, 'AwsSolutions-CFR3', 'Access logging needs an ACL-enabled bucket, which conflicts with BucketOwnerEnforced; API requests are logged by the HTTP API access log.')
    ack(distribution, 'AwsSolutions-CFR4', 'The default *.cloudfront.net certificate fixes the viewer TLS policy; set a custom domain with an ACM certificate to raise it.')
    ack(apiRole, 'AwsSolutions-IAM5[Resource::*]', 'cloudwatch:GetMetricData and DescribeAlarms have no resource-level permissions.')
    // Finding strings name CloudFormation logical ids (and the SSM parameters' CfnParameter ids).
    const lid = (c: Construct) => this.getLogicalId(c.node.defaultChild as CfnElement)
    const ssmRef = (p: RouterParam) => `SsmParameterValue${routerParamName(cfg.prefix, p).replace(/[^A-Za-z0-9]/g, '')}C96584B6F00A464EAD1953AFF4B05118Parameter`
    for (const r of ['config/versions/*', 'packs/*', 'config/baked/*']) {
      ack(apiRole, `AwsSolutions-IAM5[Resource::arn:aws:s3:::<${ssmRef('configBucket')}>/${r}]`,
        'Objects under one prefix of the config bucket (config versions, the bundled pack archive, baked config versions), nothing else.')
    }
    ack(apiRole, `AwsSolutions-IAM5[Resource::<${lid(usageTable)}.Arn>/index/*]`, 'Reads on the usage table\'s two GSIs (by day, by principal and session).')
    ack(apiRole, `AwsSolutions-IAM5[Resource::arn:aws:bedrock-agentcore:<AWS::Region>:<AWS::AccountId>:gateway/<${ssmRef('gatewayId')}>/*]`,
      'Get/List on the targets and rules of this one gateway.')
    const ownLogs = 'Log streams of the function\'s own log group.'
    ack(apiRole, `AwsSolutions-IAM5[Resource::<${lid(apiLogs)}.Arn>:*]`, ownLogs)
    ack(ingestRole, `AwsSolutions-IAM5[Resource::<${lid(ingestLogs)}.Arn>:*]`, ownLogs)
    ack(dlq, 'AwsSolutions-SQS3', 'This queue is the dead-letter destination of usage-ingest\'s asynchronous invocations.')
    if (seedParts) {
      ack(seedParts.role, `AwsSolutions-IAM5[Resource::<${lid(seedParts.logs)}.Arn>:*]`, ownLogs)
      ack(seedParts.provider, 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
        'CDK Provider framework function (CloudFormation custom-resource plumbing for the one-off admin seed).')
      ack(seedParts.provider, `AwsSolutions-IAM5[Resource::<${lid(seedParts.fn)}.Arn>:*]`, 'The Provider framework invokes the seed function (and its versions) only.')
    }
  }
}
