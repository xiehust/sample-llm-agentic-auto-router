// Router stack (design §3/§4, hop shape verified in V9d). Every deployment value comes from Settings (settings.ts).
//
//   client --JWT (Cognito client credentials)--> AgentCore Gateway (CUSTOM_JWT)
//     -> SigV4 execute-api, managed private endpoint (routingDomain = execute-api VPC endpoint)
//     -> private REST API (AWS_IAM; resource policy: the gateway role through this endpoint only)
//     -> VPC link -> internal NLB (SG: no ingress; PrivateLink traffic only) -> ECS Fargate router
//     -> bedrock-runtime / ECR / Logs interface endpoints + S3 gateway endpoint (no IGW, no NAT)
import { readFileSync } from 'node:fs'
import {
  Aws, CfnOutput, CfnParameter, type CfnResource, Duration, Fn, IgnoreMode, RemovalPolicy, Stack, type StackProps, Validations,
  aws_apigateway as apigw, aws_bedrockagentcore as agentcore, aws_cognito as cognito, aws_ec2 as ec2,
  aws_ecr_assets as ecrAssets, aws_ecs as ecs, aws_elasticloadbalancingv2 as elbv2, aws_iam as iam, aws_logs as logs,
} from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import { baseModelId, FALLBACK, invokeStatements, responsesProjectStatement, type DeployModels } from './models.ts'
import type { Settings } from './settings.ts'

export const ROUTER_PORT = 8080
/** REST API stage name: the gateway appends the operation path, so `/v1/messages` maps with no providerPath. */
export const STAGE = 'v1'
/** API Gateway REST payload cap (V9d: 12 MB gets 413 at the API). The router rejects above it too. */
export const MAX_BODY_BYTES = 10 * 1024 * 1024
/** Gateway route first-byte timeout: above the router's 600 s non-stream header timeout. */
export const FIRST_BYTE_TIMEOUT_MS = 610_000
/** Request headers the gateway forwards to the router (at most 10). */
export const REQUEST_HEADERS = [
  'x-claude-code-session-id', 'x-session-id', 'anthropic-beta', 'anthropic-version', 'openai-beta',
  'x-router-session', 'x-router-parent-session', 'x-router-agent-id', 'x-router-hint',
]
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

export interface RouterStackProps extends StackProps {
  settings: Settings
  models: DeployModels
  /** Router image; defaults to building packages/router/Dockerfile (ARM64) as a CDK asset. */
  image?: ecs.ContainerImage
}

export class RouterStack extends Stack {
  readonly gatewayName: string
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
    vpc.addGatewayEndpoint('S3', { service: ec2.GatewayVpcEndpointAwsService.S3, subnets: [subnets] })

    // ---------------------------------------------------------------- inbound auth: Cognito client credentials
    const pool = new cognito.UserPool(this, 'Users', {
      userPoolName: n('users'), selfSignUpEnabled: false, signInAliases: { username: true }, removalPolicy: RemovalPolicy.DESTROY,
      passwordPolicy: { minLength: 14, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      featurePlan: cognito.FeaturePlan.ESSENTIALS, deletionProtection: false,
    })
    const scopeDef = new cognito.ResourceServerScope({ scopeName: 'invoke', scopeDescription: 'Call the router through the gateway' })
    const rs = pool.addResourceServer('Api', { identifier: cfg.prefix, scopes: [scopeDef] })
    const client = pool.addClient('Agent', {
      userPoolClientName: n('agent-m2m'), generateSecret: true, authFlows: {}, preventUserExistenceErrors: true,
      oAuth: { flows: { clientCredentials: true }, scopes: [cognito.OAuthScope.resourceServer(rs, scopeDef)] },
      accessTokenValidity: Duration.minutes(60),
    })
    // Globally unique, non-identifying prefix: the first block of the stack GUID (never the account id).
    const suffix = Fn.select(0, Fn.split('-', Fn.select(2, Fn.split('/', Aws.STACK_ID))))
    const domain = pool.addDomain('Domain', { cognitoDomain: { domainPrefix: Fn.join('-', [cfg.prefix, suffix]) } })

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
        allowedClients: [client.userPoolClientId], allowedScopes: [invokeScope],
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
    })
    // auto* -> router; on router 5XX/connection errors -> Bedrock with a pinned standard-tier model. Rule MatchPaths
    // only accept one-segment prefixes (API pattern `/[\w\-.]+/\*`, e.g. /inference/*), so a per-API fallback model
    // is a two-step chain: the Messages model first; on Chat/Responses Bedrock rejects Claude (4XX), which moves on
    // to the OpenAI model. Costs: one extra (unbilled, rejected) Bedrock call on those paths, and if both fail the
    // client sees the last target's error. The route's first-byte timeout sits just above the router's own
    // non-stream header timeout (600 s), so the router reports first.
    // CloudFormation documents MatchModels and Fallback; this aws-cdk-lib's L1 and bundled schema predate them.
    const rule = new agentcore.CfnGatewayRule(this, 'RouteAuto', {
      gatewayIdentifier: gateway.attrGatewayIdentifier, priority: 100,
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
    const container = task.addContainer('router', {
      containerName: 'router', image, essential: true, readonlyRootFilesystem: true, user: 'node',
      portMappings: [{ name: 'http', containerPort: ROUTER_PORT, appProtocol: ecs.AppProtocol.http }],
      environment: {
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
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: routerLogs, streamPrefix: 'router' }),
    })
    const service = new ecs.FargateService(this, 'Router', {
      serviceName: n('router'), cluster, taskDefinition: task, desiredCount: cfg.desiredCount, assignPublicIp: false,
      vpcSubnets: subnets, securityGroups: [routerSg], circuitBreaker: { rollback: true }, minHealthyPercent: 100, maxHealthyPercent: 200,
      enableExecuteCommand: false, propagateTags: ecs.PropagatedTagSource.SERVICE, healthCheckGracePeriod: Duration.seconds(30),
    })
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

    // ---------------------------------------------------------------- cdk-nag (v3: Validations acknowledgements)
    const ack = (c: Construct, id: string, reason: string) => Validations.of(c).acknowledge({ id, reason })
    ack(pool, 'AwsSolutions-COG2', 'Machine-to-machine pool: client-credentials app client only, no human users or passwords.')
    ack(pool, 'AwsSolutions-COG3', 'No user sign-ins to protect (client credentials only); threat protection needs the Plus plan.')
    ack(pool, 'AwsSolutions-COG8', 'Essentials plan suffices: client-credentials tokens only, no user sign-ins for Plus threat protection to inspect.')
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
