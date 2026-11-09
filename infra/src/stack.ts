// Router stack (design §3/§4, hop shape verified in V9d). Every deployment value comes from Settings (settings.ts).
//
//   client --JWT (Cognito client credentials)--> AgentCore Gateway (CUSTOM_JWT)
//     -> SigV4 execute-api, managed private endpoint (routingDomain = execute-api VPC endpoint)
//     -> private REST API (AWS_IAM; resource policy: the gateway role through this endpoint only)
//     -> VPC link -> internal NLB (SG: no ingress; PrivateLink traffic only) -> ECS Fargate router
//     -> bedrock-runtime / ECR / Logs interface endpoints + S3 gateway endpoint (no IGW, no NAT)
import { readFileSync } from 'node:fs'
import {
  Aws, type CfnElement, CfnOutput, CfnParameter, type CfnResource, Duration, Fn, IgnoreMode, RemovalPolicy, Stack, type StackProps, Validations,
  aws_apigateway as apigw, aws_bedrockagentcore as agentcore, aws_cognito as cognito, aws_ec2 as ec2,
  aws_ecr_assets as ecrAssets, aws_ecs as ecs, aws_elasticloadbalancingv2 as elbv2, aws_events as events,
  aws_events_targets as eventsTargets, aws_iam as iam, aws_lambda as lambda, aws_logs as logs, aws_s3 as s3, aws_s3_deployment as s3deploy, aws_ssm as ssm,
} from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import { BAKED_KEY, bakedArtifact, bakedVersionKey, type BakedArtifact } from './baked.ts'
import { routerParamName, type RouterParam } from './console-stack.ts'
import { baseModelId, FALLBACK, invokeStatements, responsesProjectStatement, type DeployModels } from './models.ts'
import type { Settings } from './settings.ts'

export const ROUTER_PORT = 8080
/** REST API stage name: the gateway appends the operation path, so `/v1/messages` maps with no providerPath. */
export const STAGE = 'v1'
/** API Gateway REST payload cap (V9d: 12 MB gets 413 at the API). The router rejects above it too. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024
/** Gateway route first-byte timeout: above the router's 600 s non-stream header timeout. */
export const FIRST_BYTE_TIMEOUT_MS = 610_000
/**
 * Request headers the gateway forwards to the router (at most 10). `x-api-key` carries the client's Cognito access
 * token a second time; the router verifies it (admin console design v1 0.1, spike C1: forwarded unchanged).
 */
export const REQUEST_HEADERS = [
  'x-claude-code-session-id', 'x-session-id', 'anthropic-beta', 'anthropic-version', 'openai-beta',
  'x-router-session', 'x-router-parent-session', 'x-router-agent-id', 'x-router-hint', 'x-api-key',
]
/**
 * Request headers the Bedrock fallback target forwards. Explicit, so the client's x-api-key never reaches
 * bedrock-runtime (spike C1 S7: Bedrock answers 400 "Cannot provide both x-api-key and Authorization headers").
 */
export const BEDROCK_REQUEST_HEADERS = ['anthropic-version', 'anthropic-beta', 'openai-beta']
/** Gateway rule priorities (lower number first, spike C1 S7): auto* with fallback, then the catch-all to the router. */
export const RULE_PRIORITY = { auto: 100, catchAll: 1_000_000 } as const
/** Identity objects the router reads from the config bucket (router identity.ts, runtime config). */
export const CONFIG_KEYS = { document: 'config/active.json', identityPrefix: 'identity/', jwks: 'identity/jwks.json' } as const
/** jwks-sync period: a Cognito key rotation is picked up within this, plus the router's 30 s poll. */
export const JWKS_SYNC_MINUTES = 5
/**
 * jwks-sync (inline, CommonJS, AWS SDK v3 from the Lambda runtime): copies the pool's JWKS into identity/jwks.json when it
 * changed. Shape checks only; the router validates the keys on load and keeps the last good set.
 */
export const JWKS_SYNC_CODE = `const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const s3 = new S3Client({});
const log = (o) => console.log(JSON.stringify({ kind: 'jwks-sync', ...o }));
exports.handler = async () => {
  const res = await fetch(process.env.JWKS_URL, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('jwks fetch HTTP ' + res.status);
  const doc = JSON.parse(await res.text());
  const keys = Array.isArray(doc && doc.keys) ? doc.keys : [];
  if (keys.length < 1 || keys.length > 10 || !keys.every((k) => k && k.kty === 'RSA' && typeof k.kid === 'string' && typeof k.n === 'string' && typeof k.e === 'string')) throw new Error('jwks shape');
  const body = JSON.stringify({ keys: keys.map((k) => ({ kid: k.kid, kty: k.kty, alg: k.alg, use: k.use, n: k.n, e: k.e })) });
  const Bucket = process.env.BUCKET, Key = process.env.KEY;
  let current;
  try { current = await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToString(); } catch (e) { if (e.name !== 'NoSuchKey') throw e; }
  if (current === body) { log({ outcome: 'unchanged', keys: keys.length }); return; }
  await s3.send(new PutObjectCommand({ Bucket, Key, Body: body, ContentType: 'application/json' }));
  log({ outcome: 'written', keys: keys.length });
};`
export const RESPONSE_HEADERS = ['x-router-decision', 'x-router-model', 'x-router-reason']
const PATHS = ['/v1/messages', '/v1/chat/completions', '/v1/responses'] as const
/**
 * Integration request headers set by API Gateway. The identity values come from the IAM-verified caller; client
 * values for these names are overwritten (V9d check 3). x-amz-security-token is the gateway role's session token,
 * which API Gateway would otherwise pass through: it is replaced with a constant.
 */
export const INTEGRATION_HEADERS: Readonly<Record<string, string>> = {
  'integration.request.header.x-router-caller-arn': 'context.identity.userArn',
  'integration.request.header.x-router-source-vpce': 'context.identity.vpceId',
  'integration.request.header.x-amz-security-token': "'redacted'",
}

const GEO_REASON = 'A geographic cross-Region inference profile routes to the foundation model in any destination Region of the profile; '
  + 'the statement is limited to these profiles with bedrock:InferenceProfileArn.'
const REPO_ROOT = new URL('../../', import.meta.url).pathname

/** Router env for the identity gate (router identity.ts): the env default mode, the pool issuer and the invoke scope. */
export function identityEnv(mode: Settings['identity']['mode'], issuer: string, scope: string): Record<string, string> {
  return { ROUTER_IDENTITY_MODE: mode, ROUTER_IDENTITY_HEADER: 'x-api-key', ROUTER_IDENTITY_ISSUER: issuer, ROUTER_IDENTITY_SCOPE: scope }
}

/** Router env for the assessor settings; unset fields keep the router's defaults. */
export function assessorEnv(a: Settings['assessor']): Record<string, string> {
  if (!a) return {}
  return {
    ROUTER_ASSESSOR_MODE: a.mode,
    ...(a.model ? { ROUTER_ASSESSOR_MODEL: a.model } : {}),
    ...(a.threshold ? { ROUTER_ASSESSOR_THRESHOLD: a.threshold } : {}),
    ...(a.pack ? { ROUTER_ASSESSOR_PACK: a.pack } : {}),
    ...(a.timeoutMs ? { ROUTER_ASSESSOR_TIMEOUT_MS: a.timeoutMs } : {}),
    ...(a.autoRules ? { ROUTER_ASSESSOR_AUTO_RULES: a.autoRules } : {}),
  }
}

export interface RouterStackProps extends StackProps {
  settings: Settings
  models: DeployModels
  /** Router image; defaults to building packages/router/Dockerfile (ARM64) as a CDK asset. */
  image?: ecs.ContainerImage
  /**
   * Staged packs archive (`<dir>/packs/current.json` + `<dir>/packs/<packVersion>.json`, from the committed manifest:
   * stagePacksArchive in packs.ts). Uploaded to the config bucket root without pruning, so the packs of older images
   * stay readable for old records. Absent: no upload.
   */
  packsArchiveDir?: string
}

export class RouterStack extends Stack {
  readonly gatewayName: string
  /** The baked configuration document staged as config/baked.json (from the router env's own inputs). */
  readonly baked: BakedArtifact
  /**
   * Subnets are placed by AZ ID (cfg.azIds), so the AZ names CDK would look up for a concrete account/Region (a
   * context lookup that needs credentials at synth) are never used; two Fn::GetAZs placeholders keep synth offline.
   */
  // Nothing may consume these AZ-name placeholders (e.g. EFS mount targets, lookupSupportedAzs): subnets use AZ IDs.
  override get availabilityZones(): string[] {
    return [Fn.select(0, Fn.getAzs()), Fn.select(1, Fn.getAzs())]
  }
  constructor(scope: Construct, id: string, props: RouterStackProps) {
    super(scope, id, props)
    const { settings: cfg, models } = props
    const n = (x: string) => `${cfg.prefix}-${x}`
    this.gatewayName = n('gw')
    const invokeScope = `${cfg.prefix}/invoke`
    const s3Pl = new CfnParameter(this, 'S3PrefixListId', {
      type: 'String', allowedPattern: '^pl-[0-9a-f]+$', description: `com.amazonaws.${cfg.region}.s3 managed prefix list (ECR image layers)`,
    }).valueAsString

    // ---------------------------------------------------------------- network: private isolated subnets only
    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: n('vpc'), ipAddresses: ec2.IpAddresses.cidr('10.90.0.0/24'), maxAzs: 2, natGateways: 0,
      subnetConfiguration: [{ name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 26 }],
      restrictDefaultSecurityGroup: true, // strips the default SG's rules (CDK custom resource)
    })
    vpc.isolatedSubnets.forEach((subnet, i) => {
      const cfn = subnet.node.defaultChild as ec2.CfnSubnet
      cfn.addPropertyDeletionOverride('AvailabilityZone')
      cfn.addPropertyOverride('AvailabilityZoneId', cfg.azIds[i]) // AgentCore managed private endpoints need supported AZ IDs
    })
    // The default-SG restriction is a CDK custom-resource provider (raw CfnResources the Tags aspect skips): tag it.
    const crp = this.node.tryFindChild('Custom::VpcRestrictDefaultSGCustomResourceProvider')
    for (const id of ['Role', 'Handler']) {
      (crp?.node.tryFindChild(id) as CfnResource | undefined)?.addPropertyOverride('Tags', Object.entries(cfg.tags).map(([Key, Value]) => ({ Key, Value })))
    }
    const flowLogs = new logs.LogGroup(this, 'FlowLogs', { logGroupName: `/${cfg.prefix}/vpc-flow`, retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY })
    vpc.addFlowLog('Flow', { destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogs), trafficType: ec2.FlowLogTrafficType.REJECT })
    const subnets = { subnets: vpc.isolatedSubnets }

    const sg = (id: string, name: string, description: string) => new ec2.SecurityGroup(this, id, { vpc, securityGroupName: n(name), description, allowAllOutbound: false })
    const routerSg = sg('RouterSg', 'router', 'router task: 8080 from the NLB only; 443 to endpoints and S3')
    const nlbSg = sg('NlbSg', 'nlb', 'internal NLB: no ingress rules (VPC link / PrivateLink traffic only); 8080 to the router')
    const endpointSg = sg('EndpointSg', 'endpoints', 'AWS service endpoints: 443 from the router only')
    const rgwSg = sg('ResourceGatewaySg', 'gw-egress', 'AgentCore managed resource gateway: egress 443 to the execute-api endpoint only')
    const apiVpceSg = sg('ApiVpceSg', 'api-vpce', 'execute-api endpoint: 443 from the AgentCore resource gateway only')
    routerSg.addIngressRule(nlbSg, ec2.Port.tcp(ROUTER_PORT), 'NLB traffic and health checks')
    nlbSg.addEgressRule(routerSg, ec2.Port.tcp(ROUTER_PORT), 'router tasks')
    routerSg.addEgressRule(endpointSg, ec2.Port.tcp(443), 'AWS service endpoints')
    routerSg.addEgressRule(ec2.Peer.prefixList(s3Pl), ec2.Port.tcp(443), 'S3 gateway endpoint (ECR image layers)')
    endpointSg.addIngressRule(routerSg, ec2.Port.tcp(443), 'router tasks')
    rgwSg.addEgressRule(apiVpceSg, ec2.Port.tcp(443), 'execute-api endpoint')
    apiVpceSg.addIngressRule(rgwSg, ec2.Port.tcp(443), 'AgentCore managed resource gateway')

    const bedrockVpce = vpc.addInterfaceEndpoint('BedrockRuntime', {
      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME, subnets, securityGroups: [endpointSg], privateDnsEnabled: true, open: false,
    })
    for (const [eid, service] of [['EcrApi', ec2.InterfaceVpcEndpointAwsService.ECR],
      ['EcrDkr', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER], ['Logs', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS]] as const) {
      vpc.addInterfaceEndpoint(eid, { service, subnets, securityGroups: [endpointSg], privateDnsEnabled: true, open: false })
    }
    const s3Endpoint = vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3, subnets: [subnets] })

    // ---------------------------------------------------------------- inbound auth: Cognito (machine clients and members)
    // Members are admin-created only (no self sign-up). MFA is off by deployer decision for this sample (the live pool's
    // setting); production deployments should require TOTP MFA (mfa: REQUIRED, mfaSecondFactor { otp: true }).
    // Account recovery is e-mail only: members are invited by e-mail and have no phone numbers.
    const pool = new cognito.UserPool(this, 'Users', {
      userPoolName: n('users'), selfSignUpEnabled: false, signInAliases: { username: true }, removalPolicy: RemovalPolicy.DESTROY,
      passwordPolicy: { minLength: 14, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      featurePlan: cognito.FeaturePlan.ESSENTIALS, deletionProtection: false,
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    })
    const scopeDef = new cognito.ResourceServerScope({ scopeName: 'invoke', scopeDescription: 'Call the router through the gateway' })
    // `console`: the admin console API (ConsoleStack's console client); never granted to router callers.
    const consoleScopeDef = new cognito.ResourceServerScope({ scopeName: 'console', scopeDescription: 'Call the admin console API' })
    const rs = pool.addResourceServer('Api', { identifier: cfg.prefix, scopes: [scopeDef, consoleScopeDef] })
    const client = pool.addClient('Agent', {
      userPoolClientName: n('agent-m2m'), generateSecret: true, authFlows: {}, preventUserExistenceErrors: true,
      oAuth: { flows: { clientCredentials: true }, scopes: [cognito.OAuthScope.resourceServer(rs, scopeDef)] },
      accessTokenValidity: Duration.minutes(60),
    })
    // Globally unique, non-identifying prefix: the first block of the stack GUID (never the account id).
    const suffix = Fn.select(0, Fn.split('-', Fn.select(2, Fn.split('/', Aws.STACK_ID))))
    const domain = pool.addDomain('Domain', { cognitoDomain: { domainPrefix: Fn.join('-', [cfg.prefix, suffix]) },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN })
    // Member CLI (llmar login, Codex gateway_oauth): public client, auth code + PKCE on 127.0.0.1 loopback callbacks.
    const cliPorts = [...cfg.identity.cliRedirectPorts, cfg.identity.codexOauthPort]
    const cli = pool.addClient('Cli', {
      userPoolClientName: n('cli'), generateSecret: false, authFlows: {}, preventUserExistenceErrors: true, enableTokenRevocation: true,
      oAuth: { flows: { authorizationCodeGrant: true }, scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.resourceServer(rs, scopeDef)],
        callbackUrls: cliPorts.map((p) => `http://127.0.0.1:${p}/callback`) },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: Duration.minutes(60), idTokenValidity: Duration.minutes(60), refreshTokenValidity: Duration.days(cfg.identity.cliRefreshDays),
    })
    ;(cli.node.defaultChild as cognito.CfnUserPoolClient).refreshTokenRotation = { feature: 'ENABLED', retryGracePeriodSeconds: 30 }
    // Managed login v2: an interactive client without a branding style has no sign-in pages.
    new cognito.CfnManagedLoginBranding(this, 'CliBranding', { userPoolId: pool.userPoolId, clientId: cli.userPoolClientId, useCognitoProvidedValues: true })
      .node.addDependency(domain)

    // ---------------------------------------------------------------- gateway role (hop signer + fallback models only)
    const gatewayRole = new iam.Role(this, 'GatewayRole', {
      roleName: n('gateway-role'),
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', { conditions: {
        StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
        ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${Aws.REGION}:${Aws.ACCOUNT_ID}:gateway/${this.gatewayName}-*` },
      } }),
    })
    const grantInvoke = (role: iam.Role, ids: readonly string[], responsesIds: readonly string[], sidPrefix: string) => {
      for (const st of invokeStatements(ids, models.catalog, cfg.region, Aws.ACCOUNT_ID)) {
        role.addToPolicy(new iam.PolicyStatement({ sid: `${sidPrefix}${st.sid}`, actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          resources: st.resources, ...(st.conditions ? { conditions: st.conditions } : {}) }))
      }
      const project = responsesProjectStatement(responsesIds, cfg.region, Aws.ACCOUNT_ID)
      if (project) role.addToPolicy(new iam.PolicyStatement({ sid: `${sidPrefix}${project.sid}`, actions: ['bedrock:InvokeModel'], resources: project.resources, conditions: project.conditions }))
    }
    grantInvoke(gatewayRole, models.fallbackModels, models.fallbackResponsesModels, 'Fallback')
    gatewayRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ConnectorDiscovery', resources: ['*'],
      actions: ['bedrock:ListFoundationModels', 'bedrock:ListInferenceProfiles', 'bedrock:GetInferenceProfile', 'bedrock:GetFoundationModel',
        'bedrock:ListProvisionedModelThroughputs', 'bedrock:ListCustomModelDeployments', 'bedrock:ListImportedModels',
        'bedrock:ListMarketplaceModelEndpoints', 'bedrock:ListPromptRouters'],
    }))

    // ---------------------------------------------------------------- execute-api endpoint (private DNS off) + NLB
    // The endpoint policy admits only the gateway role (the API's resource policy names the endpoint, so the endpoint
    // policy cannot name the API without a template cycle; the role's own policy limits it to this API).
    const apiVpce = vpc.addInterfaceEndpoint('ExecuteApi', {
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY, subnets, securityGroups: [apiVpceSg], privateDnsEnabled: false, open: false,
    })
    apiVpce.addToPolicy(new iam.PolicyStatement({
      principals: [new iam.ArnPrincipal(gatewayRole.roleArn)], actions: ['execute-api:Invoke'],
      resources: [`arn:aws:execute-api:${Aws.REGION}:${Aws.ACCOUNT_ID}:*/${STAGE}/*/*`],
    }))
    const vpceDns = Fn.select(1, Fn.split(':', Fn.select(0, apiVpce.vpcEndpointDnsEntries)))

    const nlb = new elbv2.NetworkLoadBalancer(this, 'Nlb', {
      loadBalancerName: n('nlb'), vpc, internetFacing: false, vpcSubnets: subnets, securityGroups: [nlbSg],
      enforceSecurityGroupInboundRulesOnPrivateLinkTraffic: false, crossZoneEnabled: true,
    })
    const nlbListener = nlb.addListener('Router', { port: ROUTER_PORT, protocol: elbv2.Protocol.TCP })
    const vpcLink = new apigw.CfnVpcLink(this, 'VpcLink', { name: n('link'), targetArns: [nlb.loadBalancerArn] })

    // ---------------------------------------------------------------- private REST API (AWS_IAM, streaming)
    const api = new apigw.CfnRestApi(this, 'RouterApi', {
      name: n('api'), description: 'llm-auto-router hop (private, AWS_IAM)',
      endpointConfiguration: { types: ['PRIVATE'], vpcEndpointIds: [apiVpce.vpcEndpointId] },
      policy: { Version: '2012-10-17', Statement: [
        { Sid: 'GatewayRoleViaEndpoint', Effect: 'Allow', Principal: { AWS: gatewayRole.roleArn }, Action: 'execute-api:Invoke',
          Resource: `execute-api:/${STAGE}/*/*`, Condition: { StringEquals: { 'aws:SourceVpce': apiVpce.vpcEndpointId } } },
        { Sid: 'DenyOtherEndpoints', Effect: 'Deny', Principal: '*', Action: 'execute-api:Invoke', Resource: 'execute-api:/*',
          Condition: { StringNotEquals: { 'aws:SourceVpce': apiVpce.vpcEndpointId } } },
        // Same account: an identity-policy Allow alone would admit any role, so every other principal is denied explicitly.
        { Sid: 'DenyOtherPrincipals', Effect: 'Deny', Principal: '*', Action: 'execute-api:Invoke', Resource: 'execute-api:/*',
          Condition: { ArnNotEquals: { 'aws:PrincipalArn': gatewayRole.roleArn } } },
      ] },
    })
    const proxy = new apigw.CfnResource(this, 'ProxyResource', { restApiId: api.ref, parentId: api.attrRootResourceId, pathPart: '{proxy+}' })
    const method = new apigw.CfnMethod(this, 'ProxyAny', {
      restApiId: api.ref, resourceId: proxy.ref, httpMethod: 'ANY', authorizationType: 'AWS_IAM',
      requestParameters: { 'method.request.path.proxy': true },
      integration: {
        type: 'HTTP_PROXY', integrationHttpMethod: 'ANY', connectionType: 'VPC_LINK', connectionId: vpcLink.ref,
        uri: `http://${nlb.loadBalancerDnsName}:${ROUTER_PORT}/${STAGE}/{proxy}`,
        requestParameters: { 'integration.request.path.proxy': 'method.request.path.proxy', ...INTEGRATION_HEADERS },
        responseTransferMode: 'STREAM', timeoutInMillis: 900_000, passthroughBehavior: 'WHEN_NO_MATCH',
      },
    })
    const deployment = new apigw.CfnDeployment(this, 'ApiDeployment', { restApiId: api.ref, description: 'router hop' })
    deployment.node.addDependency(method)
    // Stage throttling: API Gateway and Bedrock quotas are shared by everything in the account and Region.
    const stage = new apigw.CfnStage(this, 'ApiStage', {
      restApiId: api.ref, deploymentId: deployment.ref, stageName: STAGE,
      methodSettings: [{ resourcePath: '/*', httpMethod: '*', throttlingRateLimit: cfg.throttle.rate, throttlingBurstLimit: cfg.throttle.burst }],
    })
    gatewayRole.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeRouterApi', actions: ['execute-api:Invoke'], resources: [`arn:aws:execute-api:${Aws.REGION}:${Aws.ACCOUNT_ID}:${api.ref}/${STAGE}/*/*`],
    }))

    // ---------------------------------------------------------------- AgentCore Gateway (CUSTOM_JWT)
    const gateway = new agentcore.CfnGateway(this, 'Gateway', {
      name: this.gatewayName, authorizerType: 'CUSTOM_JWT', roleArn: gatewayRole.roleArn, description: 'llm-auto-router front door',
      authorizerConfiguration: { customJwtAuthorizer: {
        discoveryUrl: `https://cognito-idp.${Aws.REGION}.amazonaws.com/${pool.userPoolId}/.well-known/openid-configuration`,
        // Scope-only (design v1 0.4): any client an admin gave the invoke scope (agent, cli, service clients) passes;
        // the console client never has it. The router verifies the caller again from x-api-key.
        allowedScopes: [invokeScope],
      } },
    })
    const routerTarget = new agentcore.CfnGatewayTarget(this, 'RouterTarget', {
      gatewayIdentifier: gateway.attrGatewayIdentifier, name: 'router', description: 'llm-auto-router data plane (private REST API, SigV4)',
      targetConfiguration: { inference: { provider: {
        endpoint: `https://${api.ref}.execute-api.${cfg.region}.amazonaws.com`,
        operations: PATHS.map((path) => ({ path, models: [{ model: 'auto' }, { model: 'auto:*' }] })),
      } } },
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE', credentialProvider: { iamCredentialProvider: { service: 'execute-api', region: cfg.region } } }],
      privateEndpoint: { managedVpcResource: {
        vpcIdentifier: vpc.vpcId, subnetIds: vpc.isolatedSubnets.map((x) => x.subnetId), endpointIpAddressType: 'IPV4',
        securityGroupIds: [rgwSg.securityGroupId], routingDomain: vpceDns, tags: cfg.tags,
      } },
      metadataConfiguration: { allowedRequestHeaders: REQUEST_HEADERS, allowedResponseHeaders: RESPONSE_HEADERS },
    })
    // Target creation runs model discovery (GET /v1/models) through the stage, so the API must be deployed first.
    routerTarget.node.addDependency(stage)
    const bedrockTarget = new agentcore.CfnGatewayTarget(this, 'BedrockTarget', {
      gatewayIdentifier: gateway.attrGatewayIdentifier, name: 'bedrock', description: 'fallback only (pinned standard-tier models)',
      targetConfiguration: { inference: { connector: { source: { connectorId: 'bedrock-runtime' } } } },
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
      metadataConfiguration: { allowedRequestHeaders: BEDROCK_REQUEST_HEADERS },
    })
    // auto* -> router; on router 5XX/connection errors -> Bedrock with a pinned standard-tier model. Rule MatchPaths
    // only accept one-segment prefixes (API pattern `/[\w\-.]+/\*`, e.g. /inference/*), so a per-API fallback model
    // is a two-step chain: the Messages model first; on Chat/Responses Bedrock rejects Claude (4XX), which moves on
    // to the OpenAI model. Costs: one extra (unbilled, rejected) Bedrock call on those paths, and if both fail the
    // client sees the last target's error. The route's first-byte timeout sits just above the router's own
    // non-stream header timeout (600 s), so the router reports first.
    // CloudFormation documents MatchModels and Fallback; this aws-cdk-lib's L1 and bundled schema predate them.
    const rule = new agentcore.CfnGatewayRule(this, 'RouteAuto', {
      gatewayIdentifier: gateway.attrGatewayIdentifier, priority: RULE_PRIORITY.auto,
      description: `auto* -> router; router 5XX -> Bedrock pinned (Messages: ${FALLBACK.messages}, Chat/Responses: ${FALLBACK.openai})`,
      actions: [{ routeToTarget: { staticRoute: { targetName: 'router' } } }],
    })
    rule.addPropertyOverride('Conditions', [
      { MatchModels: { AnyOf: [{ Value: 'auto', Operator: 'StringEquals' }, { Value: 'auto:*', Operator: 'StringLike' }] } },
    ])
    rule.addPropertyOverride('Actions.0.RouteToTarget.StaticRoute.Fallback', {
      TriggerOn: { StatusCodes: ['5XX'], Errors: ['CONNECTION_ERROR', 'UNROUTABLE', 'FIRST_BYTE_TIMEOUT'] },
      FirstByteTimeoutMilliseconds: FIRST_BYTE_TIMEOUT_MS,
      // Explicit (also the default): repeated router failures take the router out of the chain for a while, and
      // auto* traffic then goes straight to the pinned fallback model, without router decisions or accounting.
      CircuitBreaker: { Mode: 'ENABLED' },
      TargetFallback: [
        { TargetName: 'bedrock', Model: FALLBACK.messages, TriggerOn: { StatusCodes: ['5XX', '400', '404'], Errors: ['CONNECTION_ERROR', 'UNROUTABLE'] } },
        { TargetName: 'bedrock', Model: FALLBACK.openai },
      ],
    })
    // Target creation runs model discovery with the gateway role (Bedrock List* for the connector, execute-api for the
    // router). addToPolicy grants live in the role's separate DefaultPolicy resource, so the targets must wait for it,
    // or discovery races the policy attachment and the target goes FAILED (seen on the first MVP deploy).
    const gatewayPolicy = gatewayRole.node.tryFindChild('DefaultPolicy')
    if (!gatewayPolicy) throw new Error('gateway role has no DefaultPolicy')
    routerTarget.node.addDependency(gatewayPolicy)
    bedrockTarget.node.addDependency(gatewayPolicy)
    rule.node.addDependency(routerTarget)
    rule.node.addDependency(bedrockTarget)
    Validations.of(rule).acknowledge({ id: 'CloudFormation-Validate::F3018',
      reason: 'MatchModels and StaticRoute.Fallback are documented AWS::BedrockAgentCore::GatewayRule properties; the schema bundled with aws-cdk-lib predates them.' })
    // Catch-all (no conditions, lowest precedence): every other model id goes to the router too, so a concrete Bedrock id
    // can no longer reach the bedrock target directly and skip the router's identity checks (design v1 0.3, spike C1 S7).
    // The router answers ids outside its policy with 400 pin-not-allowed. No fallback: the gateway fallback stays auto*-only.
    const catchAll = new agentcore.CfnGatewayRule(this, 'RouteCatchAll', {
      gatewayIdentifier: gateway.attrGatewayIdentifier, priority: RULE_PRIORITY.catchAll,
      description: 'every other model id -> router (identity checks, pin-not-allowed); no direct bedrock target access',
      actions: [{ routeToTarget: { staticRoute: { targetName: 'router' } } }],
    })
    catchAll.node.addDependency(routerTarget)
    catchAll.node.addDependency(rule)

    // ---------------------------------------------------------------- config bucket (runtime config, identity objects)
    // Written by the console (config/, identity/blocks.json, identity/principals.json), usage-ingest
    // (identity/budget-blocks.json) and jwks-sync (identity/jwks.json); read by the router through the S3 gateway endpoint.
    const configBucket = new s3.Bucket(this, 'Config', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true, versioned: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED, removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    })

    // ---------------------------------------------------------------- ECS Fargate router
    // Container Insights off: the router's EMF metrics cover requests, cost, errors and latency.
    const cluster = new ecs.Cluster(this, 'Cluster', { clusterName: n('cluster'), vpc, containerInsightsV2: ecs.ContainerInsights.DISABLED })
    const routerLogs = new logs.LogGroup(this, 'RouterLogs', { logGroupName: `/${cfg.prefix}/router`, retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY })
    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: n('router-task'), assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com', { conditions: {
        StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
        ArnLike: { 'aws:SourceArn': `arn:aws:ecs:${Aws.REGION}:${Aws.ACCOUNT_ID}:*` },
      } }),
    })
    grantInvoke(taskRole, models.routerModels, models.routerResponsesModels, 'Router')
    // Runtime config and identity objects: read only. ListBucket makes a missing key 404 (absent) instead of 403.
    taskRole.addToPolicy(new iam.PolicyStatement({ sid: 'ConfigRead', actions: ['s3:GetObject'],
      resources: [configBucket.arnForObjects(CONFIG_KEYS.document), configBucket.arnForObjects(`${CONFIG_KEYS.identityPrefix}*`)] }))
    taskRole.addToPolicy(new iam.PolicyStatement({ sid: 'ConfigList', actions: ['s3:ListBucket'], resources: [configBucket.bucketArn] }))
    // ... and only through this VPC's S3 gateway endpoint.
    configBucket.addToResourcePolicy(new iam.PolicyStatement({ sid: 'RouterViaEndpointOnly', effect: iam.Effect.DENY,
      principals: [new iam.ArnPrincipal(taskRole.roleArn)], actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [configBucket.bucketArn, configBucket.arnForObjects('*')],
      conditions: { StringNotEquals: { 'aws:SourceVpce': s3Endpoint.vpcEndpointId } } }))
    // bedrock-runtime endpoint: only the router task role, only model invocation.
    bedrockVpce.addToPolicy(new iam.PolicyStatement({
      principals: [new iam.ArnPrincipal(taskRole.roleArn)], actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], resources: ['*'],
    }))
    const task = new ecs.FargateTaskDefinition(this, 'Task', {
      family: n('router'), cpu: 1024, memoryLimitMiB: 2048, taskRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    })
    const image = props.image ?? ecs.ContainerImage.fromDockerImageAsset(new ecrAssets.DockerImageAsset(this, 'RouterImage', {
      directory: REPO_ROOT, file: 'packages/router/Dockerfile', platform: ecrAssets.Platform.LINUX_ARM64, ignoreMode: IgnoreMode.DOCKER,
      exclude: [...readFileSync(new URL('packages/router/Dockerfile.dockerignore', `file://${REPO_ROOT}`), 'utf8').split('\n').filter((l) => l.trim()),
        '!packages/router/Dockerfile', '!packages/router/Dockerfile.dockerignore'],
    }))
    const routerEnv: Record<string, string> = {
      // awsvpc with no published host port: the wildcard bind is reachable only through the task SG (NLB SG only).
      ROUTER_BIND: '0.0.0.0', ROUTER_PORT: String(ROUTER_PORT), ROUTER_REGION: cfg.region,
      ROUTER_MAX_BODY_BYTES: String(MAX_BODY_BYTES),
      ROUTER_HOP_AUTH: 'apigw-iam', ROUTER_GATEWAY_ROLE_ARN: gatewayRole.roleArn, ROUTER_GATEWAY_ARN: gateway.attrGatewayArn,
      ROUTER_API_VPCE_ID: apiVpce.vpcEndpointId,
      // The deploy's policy (validated against the region catalog at synth); the router re-validates it at boot.
      ROUTER_POLICY_JSON: JSON.stringify(models.policy),
      ...(cfg.catalogFile ? { ROUTER_CATALOG_JSON: JSON.stringify(models.catalog) } : {}),
      ROUTER_HINTS: JSON.stringify({ chatIncludeUsage: 'inject-strip' }),
      // E2E task revisions only (-c e2eFault=… / -c e2eIdleTimeoutMs=…); the router logs a startup warning.
      ...(cfg.e2e?.fault ? { ROUTER_FAULT_INJECT: cfg.e2e.fault, ROUTER_FAULT_INJECT_ALLOW: '1' } : {}),
      ...(cfg.e2e?.idleTimeoutMs ? { ROUTER_STREAM_IDLE_TIMEOUT_MS: String(cfg.e2e.idleTimeoutMs) } : {}),
      // Tier assessor (-c assessorMode=observe|auto …): absent = off. It calls its model with this task role.
      ...assessorEnv(cfg.assessor),
      // Runtime configuration (config/active.json) and identity objects, polled every 30 s (admin console C2/C3).
      ROUTER_CONFIG_BUCKET: configBucket.bucketName,
      // Every model the task role may invoke: bounds what any runtime configuration can name.
      ROUTER_MODEL_UNIVERSE: models.routerModels.join(','),
      ...identityEnv(cfg.identity.mode, `https://cognito-idp.${Aws.REGION}.amazonaws.com/${pool.userPoolId}`, invokeScope),
    }
    // The baked document comes from this exact env (the router reads the same keys at boot): staged below.
    this.baked = bakedArtifact(models.policy, routerEnv)
    const container = task.addContainer('router', {
      containerName: 'router', image, essential: true, readonlyRootFilesystem: true, user: 'node',
      portMappings: [{ name: 'http', containerPort: ROUTER_PORT, appProtocol: ecs.AppProtocol.http }],
      environment: routerEnv,
      logging: ecs.LogDrivers.awsLogs({ logGroup: routerLogs, streamPrefix: 'router' }),
    })
    const service = new ecs.FargateService(this, 'Router', {
      serviceName: n('router'), cluster, taskDefinition: task, desiredCount: cfg.desiredCount, assignPublicIp: false,
      vpcSubnets: subnets, securityGroups: [routerSg], circuitBreaker: { rollback: true }, minHealthyPercent: 100, maxHealthyPercent: 200,
      enableExecuteCommand: false, propagateTags: ecs.PropagatedTagSource.SERVICE, healthCheckGracePeriod: Duration.seconds(30),
    })
    // ---------------------------------------------------------------- jwks-sync (pool JWKS -> identity/jwks.json, every 5 min)
    // Outside the VPC (it reads the pool's public JWKS); writes one object. The router never fetches keys at request time.
    const jwksLogs = new logs.LogGroup(this, 'JwksSyncLogs', { logGroupName: `/aws/lambda/${n('jwks-sync')}`, retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })
    const jwksRole = new iam.Role(this, 'JwksSyncRole', { roleName: n('jwks-sync-role'), assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com', {
      conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } } }) })
    jwksRole.addToPolicy(new iam.PolicyStatement({ sid: 'OwnLogs', actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${jwksLogs.logGroupArn}:*`] }))
    jwksRole.addToPolicy(new iam.PolicyStatement({ sid: 'JwksObject', actions: ['s3:GetObject', 's3:PutObject'], resources: [configBucket.arnForObjects(CONFIG_KEYS.jwks)] }))
    jwksRole.addToPolicy(new iam.PolicyStatement({ sid: 'JwksList', actions: ['s3:ListBucket'], resources: [configBucket.bucketArn] }))
    const jwksSync = new lambda.Function(this, 'JwksSync', {
      functionName: n('jwks-sync'), runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.ARM_64, handler: 'index.handler',
      code: lambda.Code.fromInline(JWKS_SYNC_CODE), role: jwksRole, logGroup: jwksLogs, timeout: Duration.seconds(30), memorySize: 128,
      environment: { JWKS_URL: `https://cognito-idp.${Aws.REGION}.amazonaws.com/${pool.userPoolId}/.well-known/jwks.json`, BUCKET: configBucket.bucketName, KEY: CONFIG_KEYS.jwks },
    })
    new events.Rule(this, 'JwksSyncSchedule', { ruleName: n('jwks-sync'), schedule: events.Schedule.rate(Duration.minutes(JWKS_SYNC_MINUTES)),
      targets: [new eventsTargets.LambdaFunction(jwksSync, { retryAttempts: 2 })] })

    // Updating a gateway target re-runs model discovery (GET /v1/models) against the router: CloudFormation must finish
    // the ECS rolling update to the new image first (2026-11-08: the target updated before the task definition, so
    // discovery hit the old image and the target went UPDATE_UNSUCCESSFUL).
    routerTarget.node.addDependency(service)
    bedrockTarget.node.addDependency(service)

    nlbListener.addTargets('RouterTasks', {
      port: ROUTER_PORT, protocol: elbv2.Protocol.TCP, deregistrationDelay: Duration.seconds(30),
      targets: [service.loadBalancerTarget({ containerName: container.containerName, containerPort: ROUTER_PORT })],
      healthCheck: { protocol: elbv2.Protocol.HTTP, path: '/healthz', interval: Duration.seconds(10), healthyThresholdCount: 2, unhealthyThresholdCount: 2 },
    })

    // ---------------------------------------------------------------- outputs (no secrets, no account ids)
    new CfnOutput(this, 'GatewayUrl', { value: gateway.attrGatewayUrl })
    new CfnOutput(this, 'TokenEndpoint', { value: `${domain.baseUrl()}/oauth2/token` })
    new CfnOutput(this, 'UserPoolId', { value: pool.userPoolId })
    new CfnOutput(this, 'AgentClientId', { value: client.userPoolClientId })
    new CfnOutput(this, 'RestApiId', { value: api.ref })
    new CfnOutput(this, 'ApiVpceId', { value: apiVpce.vpcEndpointId })
    // For the E2E runner's in-VPC probe (E0): where to place it and what to try to reach.
    new CfnOutput(this, 'VpcId', { value: vpc.vpcId })
    new CfnOutput(this, 'VpcCidr', { value: vpc.vpcCidrBlock })
    new CfnOutput(this, 'PrivateSubnetIds', { value: Fn.join(',', vpc.isolatedSubnets.map((x) => x.subnetId)) })
    new CfnOutput(this, 'ApiVpceSgId', { value: apiVpceSg.securityGroupId })
    new CfnOutput(this, 'ApiVpceDns', { value: vpceDns })
    new CfnOutput(this, 'ApiHost', { value: `${api.ref}.execute-api.${cfg.region}.amazonaws.com` })
    new CfnOutput(this, 'NlbDns', { value: nlb.loadBalancerDnsName })
    new CfnOutput(this, 'RouterLogGroup', { value: routerLogs.logGroupName })
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName })
    new CfnOutput(this, 'ServiceName', { value: service.serviceName })
    new CfnOutput(this, 'CliClientId', { value: cli.userPoolClientId })
    new CfnOutput(this, 'ConfigBucketName', { value: configBucket.bucketName })

    // ---------------------------------------------------------------- values for ConsoleStack (SSM, not stack exports)
    const gatewayBase = Fn.join('', ['https://', Fn.select(2, Fn.split('/', gateway.attrGatewayUrl))])
    const params: Record<RouterParam, string> = {
      userPoolId: pool.userPoolId, userPoolArn: pool.userPoolArn, cognitoDomain: domain.baseUrl(), gatewayId: gateway.attrGatewayIdentifier,
      gatewayUrl: gatewayBase, configBucket: configBucket.bucketName, logGroupName: routerLogs.logGroupName, clusterName: cluster.clusterName,
      serviceName: service.serviceName, serviceArn: service.serviceArn, cliClientId: cli.userPoolClientId, agentClientId: client.userPoolClientId,
      callbackPorts: cfg.identity.cliRedirectPorts.join(','), codexOauthPort: String(cfg.identity.codexOauthPort), modelUniverse: models.routerModels.join(','), identityHeader: 'x-api-key',
    }
    for (const [k, v] of Object.entries(params) as Array<[RouterParam, string]>) {
      new ssm.StringParameter(this, `Param-${k}`, { parameterName: routerParamName(cfg.prefix, k), stringValue: v, description: `llm-auto-router ${k} (read by the console stack)` })
    }

    // ---------------------------------------------------------------- cdk-nag (v3: Validations acknowledgements)
    const ack = (c: Construct, id: string, reason: string) => Validations.of(c).acknowledge({ id, reason })
    ack(pool, 'AwsSolutions-COG2', 'MFA off by deployer decision for this sample; enable TOTP MFA for production (see infra/README).')
    ack(pool, 'AwsSolutions-COG3', 'Invited team, admin-created users only (no self sign-up); threat protection needs the Plus plan (a deploy option).')
    ack(pool, 'AwsSolutions-COG8', 'Essentials plan: invited users only, no self sign-up; Plus (threat protection) is a deploy option for larger audiences.')
    // ---------------------------------------------------------------- packs archive (console: pack rules behind decisions)
    // ---------------------------------------------------------------- baked config document + packs archive
    // config/baked.json (mutable, read by ETag) and config/baked/<version>.json (immutable): the document the router
    // runs for every section the active document does not set (0d-effective-config §1–3). Built above from the task
    // definition's environment, the validated policy and the committed manifest's packs.
    // The construct id stays PacksArchive (an existing custom resource: no replacement). Prune off: packs of older images
    // and older baked versions stay readable for old records.
    const packs = new s3deploy.BucketDeployment(this, 'PacksArchive', {
      destinationBucket: configBucket, prune: false, memoryLimit: 256,
      sources: [
        ...(props.packsArchiveDir ? [s3deploy.Source.asset(props.packsArchiveDir)] : []),
        s3deploy.Source.data(BAKED_KEY, this.baked.json), s3deploy.Source.data(bakedVersionKey(this.baked.version), this.baked.json),
      ],
    })
    // BucketDeployment grants its framework Lambda read/write on the whole bucket. Outside packs/ and the baked document
    // that would let it write or delete config/active.json and the identity objects without the console's audit, so the
    // bucket denies it there.
    configBucket.addToResourcePolicy(new iam.PolicyStatement({ sid: 'PacksDeploymentOnlyUnderPacks', effect: iam.Effect.DENY,
      principals: [new iam.ArnPrincipal(packs.handlerRole.roleArn)],
      actions: ['s3:PutObject', 's3:PutObjectAcl', 's3:DeleteObject', 's3:DeleteObjectVersion'],
      notResources: [configBucket.arnForObjects('packs/*'), configBucket.arnForObjects(BAKED_KEY), configBucket.arnForObjects('config/baked/*')] }))
    const handler = this.node.children.find((c) => c.node.id.startsWith('Custom::CDKBucketDeployment'))
    if (handler) {
      const why = 'CDK BucketDeployment framework function: copies the staged packs archive and baked config document from the CDK asset bucket into the config bucket.'
      for (const f of ['AwsSolutions-L1', 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
        ...['s3:Abort*', 's3:DeleteObject*', 's3:GetBucket*', 's3:GetObject*', 's3:List*'].map((a) => `AwsSolutions-IAM5[Action::${a}]`),
        'AwsSolutions-IAM5[Resource::*]', `AwsSolutions-IAM5[Resource::<${this.getLogicalId(configBucket.node.defaultChild as CfnElement)}.Arn>/*]`,
        `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-${cfg.account}-${cfg.region}/*]`]) ack(handler, f, why)
    }
    ack(configBucket, 'AwsSolutions-S1', 'Small control-plane objects; every write is an audited console action (audit log) or a logged Lambda run. Enable CloudTrail S3 data events for object-level audit.')
    ack(jwksRole, `AwsSolutions-IAM5[Resource::<${this.getLogicalId(jwksLogs.node.defaultChild as CfnElement)}.Arn>:*]`, 'Log streams of the function\'s own log group.')
    ack(taskRole, `AwsSolutions-IAM5[Resource::<${this.getLogicalId(configBucket.node.defaultChild as CfnElement)}.Arn>/identity/*]`,
      'Read-only: the identity objects (jwks, blocks, budget blocks, principals) under one prefix of the config bucket.')
    ack(task, 'AwsSolutions-ECS2', 'Environment holds non-secret configuration only (bind, region, ARNs, the validated policy, hint flags).')
    const geoFindings = (ids: readonly string[]) => ids.filter((id) => models.catalog.models.find((m) => m.modelId === id)?.endpointScope === 'geo')
      .map((id) => `Resource::arn:aws:bedrock:*::foundation-model/${baseModelId(id)}`)
    for (const f of new Set(geoFindings(models.routerModels))) ack(taskRole, `AwsSolutions-IAM5[${f}]`, GEO_REASON)
    for (const f of new Set(geoFindings(models.fallbackModels))) ack(gatewayRole, `AwsSolutions-IAM5[${f}]`, GEO_REASON)
    const projectReason = 'Responses on bedrock-runtime authorizes InvokeModel on the default project (Bedrock User Guide, Responses API > '
      + 'Permissions); the project id is not known at synth, and bedrock:ModelArn limits the grant to this deployment\'s Responses models.'
    for (const role of [taskRole, gatewayRole]) ack(role, `AwsSolutions-IAM5[Resource::arn:aws:bedrock:${cfg.region}:<AWS::AccountId>:project/*]`, projectReason)
    ack(gatewayRole, 'AwsSolutions-IAM5[Resource::*]', 'The Bedrock connector target discovers models with List*/Get* calls that have no resource-level permissions.')
    ack(gatewayRole, `AwsSolutions-IAM5[Resource::arn:aws:execute-api:<AWS::Region>:<AWS::AccountId>:<RouterApi>/${STAGE}/*/*]`,
      'Invoke on every method and path of the one router API stage, nothing else.')
    ack(task, 'AwsSolutions-IAM5[Resource::*]', 'Execution role: ecr:GetAuthorizationToken has no resource-level permissions (CDK-generated).')
    ack(cluster, 'AwsSolutions-ECS4', 'Container Insights is off on purpose: the router emits EMF metrics for requests, cost, errors and latency.')
    ack(nlb, 'AwsSolutions-ELB2', 'Internal NLB reachable only through the VPC link; the router logs every request, and the private API is the audited front.')
    ack(method, 'AwsSolutions-COG4', 'The hop is service-to-service: AWS_IAM (SigV4 by the gateway role) is the authorizer. Cognito JWTs are validated at the AgentCore Gateway.')
    for (const c of [api, stage]) {
      ack(c, 'AwsSolutions-APIG1', 'Access logging needs the account-level API Gateway CloudWatch role; enable it per deployment. The router logs every request.')
      ack(c, 'AwsSolutions-APIG2', 'HTTP_PROXY pass-through by design: the router validates bodies (byte-exact forwarding).')
      ack(c, 'AwsSolutions-APIG3', 'Private API: reachable only through one VPC endpoint by one IAM role (resource policy); WAF adds nothing here.')
      ack(c, 'AwsSolutions-APIG6', 'Execution logging needs the account-level API Gateway CloudWatch role; enable it per deployment.')
    }
  }
}
