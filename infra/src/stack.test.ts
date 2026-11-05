import { App, Tags, Validations, aws_ecs as ecs } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks } from 'cdk-nag'
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY_FILE, deployModels, FALLBACK } from './models.ts'
import { resolveSettings } from './settings.ts'
import { REQUEST_HEADERS, RouterStack } from './stack.ts'

const ctx = (c: Record<string, string>) => ({ tryGetContext: (k: string) => c[k] })
const SETTINGS = resolveSettings(ctx({ region: 'ap-southeast-1', account: '000000000000', tags: '{"Owner":"test-owner"}' }), {}, DEFAULT_POLICY_FILE)
const MODELS = deployModels(SETTINGS)

function build(nag = false, settings = SETTINGS) {
  const app = new App({ outdir: `/tmp/llmar-infra-test-${process.pid}-${Math.random().toString(36).slice(2)}` })
  const stack = new RouterStack(app, 'llmar-router', { env: { account: settings.account, region: settings.region }, settings, models: MODELS, image: ecs.ContainerImage.fromRegistry(`${settings.account}.dkr.ecr.${settings.region}.amazonaws.com/llmar-router:test`) })
  for (const [k, v] of Object.entries(SETTINGS.tags)) Tags.of(app).add(k, v)
  if (nag) Validations.of(app).addPlugins(new AwsSolutionsChecks(app))
  return { app, stack, template: Template.fromStack(stack) }
}
const { template } = build()
const resources = template.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, any>; DeletionPolicy?: string; UpdateReplacePolicy?: string }>
const ofType = (t: string) => Object.entries(resources).filter(([, r]) => r.Type === t)

describe('llmar-mvp stack', () => {
  it('passes cdk-nag AwsSolutions with only the justified acknowledgements', () => {
    expect(() => build(true).app.synth()).not.toThrow()
  })

  it('gateway targets wait for the gateway role policy (model discovery runs at target creation)', () => {
    const raw = resources as Record<string, { Type: string; DependsOn?: string | string[]; Properties?: Record<string, any> }>
    const policy = Object.entries(raw).find(([, r]) => r.Type === 'AWS::IAM::Policy'
      && JSON.stringify(r.Properties?.Roles ?? []).includes('GatewayRole'))?.[0]
    expect(policy).toBeDefined()
    const targets = Object.entries(raw).filter(([, r]) => r.Type === 'AWS::BedrockAgentCore::GatewayTarget')
    expect(targets.length).toBe(2)
    for (const [, t] of targets) expect([t.DependsOn ?? []].flat()).toContain(policy)
  })

  it('has no internet path: no IGW, no NAT, no public IPs', () => {
    template.resourceCountIs('AWS::EC2::InternetGateway', 0)
    template.resourceCountIs('AWS::EC2::NatGateway', 0)
    for (const [, s] of ofType('AWS::EC2::Subnet')) expect(s.Properties?.MapPublicIpOnLaunch ?? false).toBe(false)
    const svc = ofType('AWS::ECS::Service')[0]?.[1]
    expect(svc?.Properties?.NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp).toBe('DISABLED')
  })

  it('never opens ingress to 0.0.0.0/0 or ::/0', () => {
    const rules = [...ofType('AWS::EC2::SecurityGroupIngress').map(([, r]) => r.Properties),
      ...ofType('AWS::EC2::SecurityGroup').flatMap(([, r]) => r.Properties?.SecurityGroupIngress ?? [])]
    for (const r of rules) { expect(r?.CidrIp).not.toBe('0.0.0.0/0'); expect(r?.CidrIpv6).not.toBe('::/0') }
  })

  const sgByName = (name: string) => ofType('AWS::EC2::SecurityGroup').find(([, r]) => r.Properties?.GroupName === name)?.[0] as string
  const rulesOf = (type: 'AWS::EC2::SecurityGroupIngress' | 'AWS::EC2::SecurityGroupEgress', sgId: string) =>
    ofType(type).map(([, r]) => r.Properties ?? {}).filter((r) => JSON.stringify(r.GroupId).includes(sgId))
  const inline = (sgId: string) => (resources[sgId]?.Properties?.SecurityGroupIngress ?? []) as Record<string, any>[]

  it('router SG: ingress 8080 only from the NLB SG; egress 443 only', () => {
    const router = sgByName('llmar-router')
    const ingress = [...rulesOf('AWS::EC2::SecurityGroupIngress', router), ...inline(router)]
    expect(ingress).toHaveLength(1)
    expect(ingress[0]).toMatchObject({ FromPort: 8080, ToPort: 8080, SourceSecurityGroupId: { 'Fn::GetAtt': [sgByName('llmar-nlb'), 'GroupId'] } })
    const egress = rulesOf('AWS::EC2::SecurityGroupEgress', router)
    expect(egress.length).toBeGreaterThan(0)
    for (const e of egress) expect([e.FromPort, e.ToPort]).toEqual([443, 443])
  })

  it('NLB: internal, SG with no ingress rules, PrivateLink inbound rules not enforced (VPC link traffic only)', () => {
    const nlb = sgByName('llmar-nlb')
    expect([...rulesOf('AWS::EC2::SecurityGroupIngress', nlb), ...inline(nlb)]).toHaveLength(0)
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Type: 'network', Scheme: 'internal', EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: 'off',
    })
  })

  it('execute-api endpoint: private DNS off, SG admits only the resource gateway SG, policy admits only the gateway role', () => {
    const vpce = ofType('AWS::EC2::VPCEndpoint').find(([, r]) => JSON.stringify(r.Properties?.ServiceName).includes('execute-api'))?.[1].Properties
    expect(vpce?.PrivateDnsEnabled).toBe(false)
    const st = vpce?.PolicyDocument.Statement
    expect(st).toHaveLength(1)
    expect(st[0]).toMatchObject({ Effect: 'Allow', Action: 'execute-api:Invoke', Principal: { AWS: { 'Fn::GetAtt': [expect.stringMatching(/^GatewayRole/), 'Arn'] } } })
    const apiSg = sgByName('llmar-api-vpce')
    const ingress = [...rulesOf('AWS::EC2::SecurityGroupIngress', apiSg), ...inline(apiSg)]
    expect(ingress).toHaveLength(1)
    expect(ingress[0]).toMatchObject({ FromPort: 443, SourceSecurityGroupId: { 'Fn::GetAtt': [sgByName('llmar-gw-egress'), 'GroupId'] } })
  })

  it('REST API: PRIVATE, AWS_IAM, explicit denies for other endpoints and other principals (same-account evaluation)', () => {
    const api = ofType('AWS::ApiGateway::RestApi')[0]?.[1].Properties
    expect(api?.EndpointConfiguration.Types).toEqual(['PRIVATE'])
    const sids = api?.Policy.Statement.map((x: any) => [x.Sid, x.Effect])
    expect(sids).toEqual([['GatewayRoleViaEndpoint', 'Allow'], ['DenyOtherEndpoints', 'Deny'], ['DenyOtherPrincipals', 'Deny']])
    expect(api?.Policy.Statement[2].Condition.ArnNotEquals['aws:PrincipalArn']).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^GatewayRole/), 'Arn'] })
    template.hasResourceProperties('AWS::ApiGateway::Stage', { StageName: 'v1' })
  })

  it('integration: HTTP_PROXY over the VPC link, streaming, 15 min, identity headers mapped and the session token overwritten', () => {
    const m = ofType('AWS::ApiGateway::Method')[0]?.[1].Properties
    expect(m).toMatchObject({ HttpMethod: 'ANY', AuthorizationType: 'AWS_IAM' })
    expect(m?.Integration).toMatchObject({ Type: 'HTTP_PROXY', ConnectionType: 'VPC_LINK', ResponseTransferMode: 'STREAM', TimeoutInMillis: 900000 })
    expect(m?.Integration.RequestParameters).toMatchObject({
      'integration.request.header.x-router-caller-arn': 'context.identity.userArn',
      'integration.request.header.x-router-source-vpce': 'context.identity.vpceId',
      'integration.request.header.x-amz-security-token': "'redacted'",
    })
    expect(JSON.stringify(m?.Integration.Uri)).toContain(':8080/v1/{proxy}')
  })

  it('no IAM statement allows a wildcard action', () => {
    for (const [, p] of [...ofType('AWS::IAM::Policy'), ...ofType('AWS::IAM::Role')]) {
      const docs = [p.Properties?.PolicyDocument, ...(p.Properties?.Policies ?? []).map((x: any) => x.PolicyDocument)].filter(Boolean)
      // Any `*` in an action (`*`, `svc:*`, `svc:Invoke*`), and NotAction (an implicit wildcard), fail.
      for (const d of docs) for (const s of d.Statement) {
        expect(s.NotAction).toBeUndefined()
        for (const a of [s.Action].flat()) expect(String(a)).not.toContain('*')
      }
    }
  })

  it('task role invokes exactly the router models via the documented global-profile pattern; gateway role only the fallback models', () => {
    const doc = (prefix: string) => ofType('AWS::IAM::Policy').find(([id]) => id.startsWith(prefix))?.[1].Properties?.PolicyDocument
    const task = doc('TaskRole')
    const bases = new Set(MODELS.routerModels.map((m) => m.replace(/^global\./, '')))
    const resources: string[] = task.Statement.flatMap((st: any) => [st.Resource].flat()).map((x: unknown) => JSON.stringify(x))
    const project = task.Statement.find((st: any) => st.Sid === 'RouterResponsesDefaultProject')
    for (const st of task.Statement.filter((x: any) => x !== project)) for (const r of [st.Resource].flat().map((x: unknown) => JSON.stringify(x))) {
      const m = /(?:inference-profile\/global\.|foundation-model\/)([a-z0-9.:-]+)"/.exec(r)
      expect(m, r).not.toBeNull()
      expect(bases.has(m?.[1] as string), r).toBe(true)
      expect(r, 'no wildcards').not.toMatch(/\*/)
    }
    const sids = task.Statement.map((st: any) => st.Sid)
    expect(sids).toEqual(['RouterInferenceProfiles', 'RouterProfileModelsInRegion', 'RouterGlobalProfileModels', 'RouterResponsesDefaultProject'])
    // Responses needs InvokeModel on the default project, limited by bedrock:ModelArn to the Responses pool's profiles.
    expect(project.Action).toBe('bedrock:InvokeModel')
    expect(JSON.stringify(project.Resource)).toContain(':project/*')
    expect(JSON.stringify(project.Condition.StringEquals['bedrock:ModelArn'])).toContain('inference-profile/global.openai.gpt-6.1-sol')
    expect(JSON.stringify(project.Condition.StringEquals['bedrock:ModelArn'])).not.toContain('anthropic')
    const globalFm = task.Statement.find((st: any) => st.Sid === 'RouterGlobalProfileModels')
    expect(globalFm.Condition.StringEquals['aws:RequestedRegion']).toBe('unspecified')
    expect(JSON.stringify(globalFm.Resource)).toContain('arn:aws:bedrock:::foundation-model/anthropic.claude-sonnet-5-5')
    const gw = JSON.stringify(doc('GatewayRole'))
    for (const m of Object.values(FALLBACK)) expect(gw).toContain(m)
    expect(gw).not.toContain('claude-opus')
    expect(gw).not.toContain('gpt-6-luna')
    expect(gw).toContain('FallbackResponsesDefaultProject') // GPT-6.1 Sol serves Responses on fallback
  })

  it('settings: region and account are explicit; AZ IDs, prefix, tags and throttle are deploy inputs with no personal default', () => {
    expect(() => resolveSettings(ctx({ account: '000000000000' }), { CDK_DEFAULT_REGION: 'ap-southeast-1', AWS_REGION: 'ap-southeast-1' }, DEFAULT_POLICY_FILE)).toThrow(/region: required \(-c region=<aws-region>\)/)
    expect(() => resolveSettings(ctx({ region: 'ap-southeast-1' }), { CDK_DEFAULT_ACCOUNT: '000000000000' }, DEFAULT_POLICY_FILE)).toThrow(/account: required/)
    expect(() => resolveSettings(ctx({ region: 'ap-southeast-1', account: 'env' }), {}, DEFAULT_POLICY_FILE)).toThrow(/account=env needs CDK_DEFAULT_ACCOUNT/)
    expect(resolveSettings(ctx({ region: 'ap-southeast-1', account: 'env' }), { CDK_DEFAULT_ACCOUNT: '111111111111' }, DEFAULT_POLICY_FILE).account).toBe('111111111111')
    const base = { account: '000000000000' }
    expect(() => resolveSettings(ctx({ ...base, region: 'eu-west-3' }), {}, DEFAULT_POLICY_FILE)).toThrow(/azIds: two AZ IDs required/)
    const eu = resolveSettings(ctx({ ...base, region: 'eu-west-3', azIds: 'euw3-az1,euw3-az2', prefix: 'acme', throttle: '5,10' }), {}, DEFAULT_POLICY_FILE)
    expect(eu).toMatchObject({ region: 'eu-west-3', azIds: ['euw3-az1', 'euw3-az2'], prefix: 'acme', tags: { Project: 'llm-auto-router', Purpose: 'mvp' }, throttle: { rate: 5, burst: 10 } })
    expect(eu.tags.Owner).toBeUndefined()
    expect(SETTINGS.throttle).toEqual({ rate: 20, burst: 40 })
    expect(() => resolveSettings(ctx({ ...base, region: 'ap-southeast-1', throttle: 'x' }), {}, DEFAULT_POLICY_FILE)).toThrow(/throttle/)
    expect(() => deployModels(eu)).toThrow(/no bundled price catalog for region 'eu-west-3'/)
    expect(resolveSettings(ctx({ ...base, region: 'ap-northeast-1' }), {}, DEFAULT_POLICY_FILE).azIds).toEqual(['apne1-az1', 'apne1-az2'])
    const tokyoExample = new URL('../../packages/router/config/policy.example.ap-northeast-1.json', import.meta.url).pathname
    expect(() => deployModels({ ...SETTINGS, policyFile: tokyoExample })).toThrow(/policy vs ap-southeast-1 catalog:.*jp\.anthropic/s)
    expect(deployModels({ ...SETTINGS, region: 'ap-northeast-1', azIds: ['apne1-az1', 'apne1-az2'], policyFile: tokyoExample }).routerModels).toContain('jp.anthropic.claude-haiku-5-5')
  })

  it('stage throttling, fallback first-byte timeout, Container Insights off, endpoint policy on bedrock-runtime', () => {
    expect(ofType('AWS::ApiGateway::Stage')[0]?.[1].Properties?.MethodSettings).toEqual([{ ResourcePath: '/*', HttpMethod: '*', ThrottlingRateLimit: 20, ThrottlingBurstLimit: 40 }])
    const fb = ofType('AWS::BedrockAgentCore::GatewayRule')[0]?.[1].Properties?.Actions[0].RouteToTarget.StaticRoute.Fallback
    expect(fb.FirstByteTimeoutMilliseconds).toBe(610000)
    expect(fb.TriggerOn.Errors).toContain('FIRST_BYTE_TIMEOUT')
    expect(fb.CircuitBreaker).toEqual({ Mode: 'ENABLED' })
    const cluster = ofType('AWS::ECS::Cluster')[0]?.[1].Properties
    expect(cluster?.ClusterSettings).toEqual([{ Name: 'containerInsights', Value: 'disabled' }])
    const br = ofType('AWS::EC2::VPCEndpoint').find(([, r]) => JSON.stringify(r.Properties?.ServiceName).includes('bedrock-runtime'))?.[1].Properties
    expect(br?.PolicyDocument.Statement).toEqual([expect.objectContaining({
      Effect: 'Allow', Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], Principal: { AWS: { 'Fn::GetAtt': [expect.stringMatching(/^TaskRole/), 'Arn'] } },
    })])
  })

  it('e2e context keys only add the fault and idle env to the router (and are validated)', () => {
    const e2e = resolveSettings(ctx({ region: 'ap-southeast-1', account: '000000000000', e2eFault: 'pause-after-first-frame:330000', e2eIdleTimeoutMs: '420000' }), {}, DEFAULT_POLICY_FILE)
    const { template: t } = build(false, e2e)
    const env = Object.fromEntries(t.toJSON().Resources[Object.keys(t.toJSON().Resources).find((k) => t.toJSON().Resources[k].Type === 'AWS::ECS::TaskDefinition') as string]
      .Properties.ContainerDefinitions[0].Environment.map((x: any) => [x.Name, x.Value]))
    expect(env).toMatchObject({ ROUTER_FAULT_INJECT: 'pause-after-first-frame:330000', ROUTER_FAULT_INJECT_ALLOW: '1', ROUTER_STREAM_IDLE_TIMEOUT_MS: '420000' })
    expect(() => resolveSettings(ctx({ region: 'ap-southeast-1', account: '000000000000', e2eFault: 'drop-tables' }), {}, DEFAULT_POLICY_FILE)).toThrow(/e2eFault/)
    expect(resolveSettings(ctx({ region: 'ap-southeast-1', account: '000000000000', e2eFault: 'upstream-503-once:2' }), {}, DEFAULT_POLICY_FILE).e2e).toEqual({ fault: 'upstream-503-once:2' })
    expect(() => resolveSettings(ctx({ region: 'ap-southeast-1', account: '000000000000', e2eFault: 'upstream-503-once:0' }), {}, DEFAULT_POLICY_FILE)).toThrow(/e2eFault/)
  })

  it('names follow the prefix, subnets use the AZ IDs, and the router gets the region and the validated policy', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', { Name: 'llmar-gw' })
    expect(ofType('AWS::EC2::Subnet').map(([, r]) => r.Properties?.AvailabilityZoneId).sort()).toEqual(['apse1-az1', 'apse1-az2'])
    const env = Object.fromEntries(ofType('AWS::ECS::TaskDefinition')[0]?.[1].Properties?.ContainerDefinitions[0].Environment.map((e: any) => [e.Name, e.Value]))
    expect(env.ROUTER_REGION).toBe('ap-southeast-1')
    expect(JSON.parse(env.ROUTER_POLICY_JSON).version).toBe(MODELS.policy.version)
  })

  it('gateway: CUSTOM_JWT with the M2M client and scope; router target signs execute-api through the VPCE routing domain', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', { Name: 'llmar-gw', AuthorizerType: 'CUSTOM_JWT' })
    const gw = ofType('AWS::BedrockAgentCore::Gateway')[0]?.[1].Properties
    expect(gw?.AuthorizerConfiguration.CustomJWTAuthorizer.AllowedScopes).toEqual(['llmar/invoke'])
    const router = ofType('AWS::BedrockAgentCore::GatewayTarget').find(([, r]) => r.Properties?.Name === 'router')?.[1].Properties
    expect(router?.CredentialProviderConfigurations[0].CredentialProvider.IamCredentialProvider).toEqual({ Service: 'execute-api', Region: 'ap-southeast-1' })
    expect(JSON.stringify(router?.TargetConfiguration.Inference.Provider.Endpoint)).toContain('.execute-api.ap-southeast-1.amazonaws.com')
    expect(router?.PrivateEndpoint.ManagedVpcResource.RoutingDomain).toBeDefined()
    expect(router?.PrivateEndpoint.ManagedVpcResource.Tags).toEqual(SETTINGS.tags)
    expect(router?.MetadataConfiguration.AllowedRequestHeaders).toEqual(REQUEST_HEADERS)
    expect(REQUEST_HEADERS.length).toBeLessThanOrEqual(10)
    expect(REQUEST_HEADERS.some((h) => h.startsWith('x-amz') || h === 'x-router-caller-arn' || h === 'x-router-source-vpce')).toBe(false)
  })

  it('fallback rule: auto* -> router, then Sonnet 5.5, then GPT-6.1 Sol', () => {
    const rule = ofType('AWS::BedrockAgentCore::GatewayRule')[0]?.[1].Properties
    expect(rule?.Conditions[0].MatchModels.AnyOf.map((m: any) => m.Value)).toEqual(['auto', 'auto:*'])
    const fb = rule?.Actions[0].RouteToTarget.StaticRoute
    expect(fb.TargetName).toBe('router')
    expect(fb.Fallback.TargetFallback.map((t: any) => t.Model)).toEqual(['global.anthropic.claude-sonnet-5-5', 'global.openai.gpt-6.1-sol'])
  })

  it('container binds 0.0.0.0 inside awsvpc with no host port, hop auth apigw-iam, 10 MiB cap, desired count 0 by default', () => {
    const c = ofType('AWS::ECS::TaskDefinition')[0]?.[1].Properties?.ContainerDefinitions[0]
    expect(c.PortMappings).toEqual([{ AppProtocol: 'http', ContainerPort: 8080, Name: 'http', Protocol: 'tcp' }])
    const env = Object.fromEntries(c.Environment.map((e: any) => [e.Name, e.Value]))
    expect(env).toMatchObject({ ROUTER_BIND: '0.0.0.0', ROUTER_HOP_AUTH: 'apigw-iam', ROUTER_MAX_BODY_BYTES: String(10 * 1024 * 1024) })
    expect(env.ROUTER_API_VPCE_ID).toBeDefined()
    expect(env.ROUTER_INBOUND_TEST_BYPASS).toBeUndefined()
    expect(env.ROUTER_FAULT_INJECT).toBeUndefined() // only with -c e2eFault
    expect(c.ReadonlyRootFilesystem).toBe(true)
    template.hasResourceProperties('AWS::ECS::Service', { DesiredCount: 0, LoadBalancers: [{ ContainerName: 'router', ContainerPort: 8080 }] })
  })

  it('every taggable resource carries Project/Owner/Purpose, and nothing is retained', () => {
    const want = { Project: 'llm-auto-router', Owner: 'test-owner', Purpose: 'mvp' }
    for (const [id, r] of Object.entries(resources)) {
      expect(r.DeletionPolicy ?? 'Delete', id).not.toBe('Retain')
      expect(r.UpdateReplacePolicy ?? 'Delete', id).not.toBe('Retain')
      const tags = r.Properties?.Tags ?? r.Properties?.UserPoolTags
      if (!tags) continue
      const map = Array.isArray(tags) ? Object.fromEntries(tags.map((t: any) => [t.Key, t.Value])) : tags
      expect(map, id).toMatchObject(want)
    }
    for (const t of ['AWS::EC2::VPC', 'AWS::ECS::Service', 'AWS::ApiGateway::RestApi', 'AWS::BedrockAgentCore::Gateway', 'AWS::IAM::Role', 'AWS::Logs::LogGroup']) {
      for (const [id, r] of ofType(t)) expect(r.Properties?.Tags, `${t} ${id}`).toBeTruthy()
    }
  })

  it('outputs carry no secrets', () => {
    const outs = JSON.stringify(template.toJSON().Outputs)
    expect(outs).not.toMatch(/ClientSecret|secret/i)
  })
})
