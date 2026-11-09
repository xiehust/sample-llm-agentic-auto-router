import { describe, expect, it } from 'vitest'
import { createInboundCheck } from './inbound.ts'
import { hopHeaders, TEST_GATEWAY_ARN, TEST_ROLE_ARN, TEST_VPCE } from './test-helpers.ts'

const check = createInboundCheck({ kind: 'apigw-iam', gatewayRoleArn: TEST_ROLE_ARN, gatewayArn: TEST_GATEWAY_ARN, vpceId: TEST_VPCE })

describe('inbound check (apigw-iam)', () => {
  it('accepts the gateway role session through the configured VPC endpoint with the gateway source ARN', () => {
    expect(check(hopHeaders())).toEqual({ ok: true, principal: 'role/llmar-gateway-role' })
  })

  it.each([
    ['no caller', { 'x-router-source-vpce': TEST_VPCE, 'x-amz-source-arn': TEST_GATEWAY_ARN }, 'caller-missing'],
    ['another role', hopHeaders('admin'), 'principal-not-gateway'],
    ['other account', { ...hopHeaders(), 'x-router-caller-arn': 'arn:aws:sts::999999999999:assumed-role/llmar-gateway-role/s' }, 'principal-not-gateway'],
    ['an IAM user', { ...hopHeaders(), 'x-router-caller-arn': 'arn:aws:iam::000000000000:user/llmar-gateway-role' }, 'principal-not-gateway'],
    ['other endpoint', hopHeaders(undefined, undefined, 'vpce-0ffffffffffffffff'), 'vpce-mismatch'],
    ['no endpoint', { 'x-router-caller-arn': hopHeaders()['x-router-caller-arn'], 'x-amz-source-arn': TEST_GATEWAY_ARN }, 'vpce-mismatch'],
    ['wrong gateway', hopHeaders(undefined, TEST_GATEWAY_ARN.replace('abc123', 'other')), 'source-arn-mismatch'],
    ['no source arn', { 'x-router-caller-arn': hopHeaders()['x-router-caller-arn'], 'x-router-source-vpce': TEST_VPCE }, 'source-arn-mismatch'],
    ['source account mismatch', { ...hopHeaders(), 'x-amz-source-account': '999999999999' }, 'source-account-mismatch'],
  ])('rejects %s', (_name, headers, reason) => {
    expect(check(headers)).toMatchObject({ ok: false, reason })
  })

  it('rejects repeated identity headers as node:http delivers them (joined with a comma)', () => {
    const h = hopHeaders()
    const forged = 'arn:aws:sts::000000000000:assumed-role/llmar-gateway-role/forged'
    expect(check({ ...h, 'x-router-caller-arn': `${forged}, ${h['x-router-caller-arn']}` })).toEqual({ ok: false, reason: 'caller-repeated' })
    expect(check({ ...h, 'x-router-source-vpce': `vpce-0aaaaaaaaaaaaaaaa, ${TEST_VPCE}` })).toEqual({ ok: false, reason: 'vpce-repeated' })
    expect(check({ ...h, 'x-amz-source-arn': `${TEST_GATEWAY_ARN}, ${TEST_GATEWAY_ARN}` })).toEqual({ ok: false, reason: 'source-arn-repeated', sourceArn: 'other' })
  })

  it('fails closed when unconfigured or misconfigured, and the bypass is explicit', () => {
    expect(createInboundCheck({ kind: 'reject' })(hopHeaders())).toEqual({ ok: false, reason: 'hop-auth-unconfigured' })
    expect(createInboundCheck({ kind: 'apigw-iam', gatewayRoleArn: 'not-an-arn', gatewayArn: TEST_GATEWAY_ARN, vpceId: TEST_VPCE })(hopHeaders()).ok).toBe(false)
    expect(createInboundCheck({ kind: 'test-bypass' })({}).ok).toBe(true)
  })

  it('model discovery (GET /v1/models): source ARN absent or exactly the gateway; caller and endpoint still required', () => {
    const noSource = { 'x-router-caller-arn': hopHeaders()['x-router-caller-arn'], 'x-router-source-vpce': TEST_VPCE }
    expect(check(noSource, { discovery: true })).toEqual({ ok: true, principal: 'role/llmar-gateway-role', sourceArn: 'absent' })
    expect(check(hopHeaders(), { discovery: true })).toEqual({ ok: true, principal: 'role/llmar-gateway-role' })
    expect(check({ ...noSource, 'x-router-caller-arn': hopHeaders('admin')['x-router-caller-arn'] }, { discovery: true })).toEqual({ ok: false, reason: 'principal-not-gateway' })
    expect(check({ ...noSource, 'x-router-source-vpce': 'vpce-0ffffffffffffffff' }, { discovery: true })).toEqual({ ok: false, reason: 'vpce-mismatch' })
    expect(check({ ...hopHeaders(), 'x-amz-source-account': '999999999999' }, { discovery: true })).toMatchObject({ ok: false, reason: 'source-account-mismatch' })
    expect(check({ ...noSource, 'x-amz-source-account': '999999999999' }, { discovery: true })).toEqual({ ok: false, reason: 'source-account-mismatch', sourceArn: 'absent' })
  })

  it.each([
    ['gateway-subresource', `${TEST_GATEWAY_ARN}/target/abc`, 'source-arn-mismatch', 'gateway-subresource'],
    ['other-agentcore', TEST_GATEWAY_ARN.replace('abc123', 'other'), 'source-arn-mismatch', 'other-agentcore'],
    ['other', 'arn:aws:lambda:ap-northeast-1:000000000000:function:x', 'source-arn-mismatch', 'other'],
    ['empty', '', 'source-arn-mismatch', 'other'],
    ['repeated (joined)', `${TEST_GATEWAY_ARN}, ${TEST_GATEWAY_ARN}`, 'source-arn-repeated', 'other'],
  ])('model discovery rejects a %s source ARN and reports the shape', (_name, value, reason, shape) => {
    expect(check(hopHeaders(undefined, value), { discovery: true })).toEqual({ ok: false, reason, sourceArn: shape })
  })

  it('model discovery rejects a repeated source ARN delivered as an array', () => {
    const h = { ...hopHeaders(), 'x-amz-source-arn': [TEST_GATEWAY_ARN, TEST_GATEWAY_ARN] } as unknown as Parameters<typeof check>[0]
    expect(check(h, { discovery: true })).toEqual({ ok: false, reason: 'source-arn-repeated', sourceArn: 'other' })
  })

  it('inference keeps the strict source-ARN check and reports the shape, never the value', () => {
    const noSource = { 'x-router-caller-arn': hopHeaders()['x-router-caller-arn'], 'x-router-source-vpce': TEST_VPCE }
    expect(check(noSource)).toEqual({ ok: false, reason: 'source-arn-mismatch', sourceArn: 'absent' })
    expect(check(hopHeaders(undefined, `${TEST_GATEWAY_ARN}/target/abc`))).toEqual({ ok: false, reason: 'source-arn-mismatch', sourceArn: 'gateway-subresource' })
    expect(check(hopHeaders(undefined, TEST_GATEWAY_ARN.replace('abc123', 'other')))).toEqual({ ok: false, reason: 'source-arn-mismatch', sourceArn: 'other-agentcore' })
    expect(check(hopHeaders(undefined, 'arn:aws:lambda:ap-northeast-1:000000000000:function:x'))).toEqual({ ok: false, reason: 'source-arn-mismatch', sourceArn: 'other' })
    expect(check({ ...hopHeaders(), 'x-amz-source-arn': `${TEST_GATEWAY_ARN}, ${TEST_GATEWAY_ARN}` })).toEqual({ ok: false, reason: 'source-arn-repeated', sourceArn: 'other' })
  })
})
