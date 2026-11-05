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
    expect(check(headers)).toEqual({ ok: false, reason })
  })

  it('rejects repeated identity headers as node:http delivers them (joined with a comma)', () => {
    const h = hopHeaders()
    const forged = 'arn:aws:sts::000000000000:assumed-role/llmar-gateway-role/forged'
    expect(check({ ...h, 'x-router-caller-arn': `${forged}, ${h['x-router-caller-arn']}` })).toEqual({ ok: false, reason: 'caller-repeated' })
    expect(check({ ...h, 'x-router-source-vpce': `vpce-0aaaaaaaaaaaaaaaa, ${TEST_VPCE}` })).toEqual({ ok: false, reason: 'vpce-repeated' })
    expect(check({ ...h, 'x-amz-source-arn': `${TEST_GATEWAY_ARN}, ${TEST_GATEWAY_ARN}` })).toEqual({ ok: false, reason: 'source-arn-repeated' })
  })

  it('fails closed when unconfigured or misconfigured, and the bypass is explicit', () => {
    expect(createInboundCheck({ kind: 'reject' })(hopHeaders())).toEqual({ ok: false, reason: 'hop-auth-unconfigured' })
    expect(createInboundCheck({ kind: 'apigw-iam', gatewayRoleArn: 'not-an-arn', gatewayArn: TEST_GATEWAY_ARN, vpceId: TEST_VPCE })(hopHeaders()).ok).toBe(false)
    expect(createInboundCheck({ kind: 'test-bypass' })({}).ok).toBe(true)
  })
})
