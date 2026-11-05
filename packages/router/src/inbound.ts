// Gateway -> router hop verification (design §2.3), fail-closed. With apigw-iam, API Gateway (private REST API,
// AWS_IAM) has already verified SigV4 and evaluated its resource policy (gateway role only, via one VPC endpoint).
// It then sets x-router-caller-arn (context.identity.userArn) and x-router-source-vpce (context.identity.vpceId) on
// the integration request, overwriting client values (V9d check 3). This is defence in depth on those values.
import type { IncomingHttpHeaders } from 'node:http'
import type { HopAuth } from './config.ts'

export type InboundResult = { ok: true; principal?: string } | { ok: false; reason: string }
export type InboundCheck = (headers: IncomingHttpHeaders) => InboundResult

/**
 * One header value, or null when it is ambiguous: node:http joins a repeated header with ', ', and an array means
 * set-cookie style repetition. ARNs, VPCE ids and ARNs never contain a comma, so a comma means two values.
 */
function single(headers: IncomingHttpHeaders, name: string): string | undefined | null {
  const v = headers[name]
  if (Array.isArray(v)) return null
  if (v !== undefined && v.includes(',')) return null
  return v
}

/** `arn:aws:iam::<acct>:role[/path]/<name>` -> { account, name }. */
function roleOf(arn: string): { account: string; name: string } | undefined {
  const m = /^arn:aws:iam::(\d{12}):role\/(?:[\w+=,.@-]+\/)*([\w+=,.@-]+)$/.exec(arn)
  return m ? { account: m[1] as string, name: m[2] as string } : undefined
}

/** Assumed-role session or role principal -> { account, name }. */
function principalRole(principal: string): { account: string; name: string } | undefined {
  const m = /^arn:aws:sts::(\d{12}):assumed-role\/([\w+=,.@-]+)\/[\w+=,.@-]+$/.exec(principal)
  return m ? { account: m[1] as string, name: m[2] as string } : roleOf(principal)
}

export function createInboundCheck(auth: HopAuth): InboundCheck {
  if (auth.kind === 'test-bypass') return () => ({ ok: true, principal: 'test-bypass' })
  if (auth.kind !== 'apigw-iam') return () => ({ ok: false, reason: 'hop-auth-unconfigured' })
  const want = roleOf(auth.gatewayRoleArn)
  if (!want) return () => ({ ok: false, reason: 'hop-auth-unconfigured' })
  return (headers) => {
    const caller = single(headers, 'x-router-caller-arn')
    if (!caller) return { ok: false, reason: caller === null ? 'caller-repeated' : 'caller-missing' }
    const got = principalRole(caller)
    if (!got || got.account !== want.account || got.name !== want.name) return { ok: false, reason: 'principal-not-gateway' }
    const vpce = single(headers, 'x-router-source-vpce')
    if (vpce !== auth.vpceId) return { ok: false, reason: vpce === null ? 'vpce-repeated' : 'vpce-mismatch' }
    const source = single(headers, 'x-amz-source-arn')
    if (source !== auth.gatewayArn) return { ok: false, reason: source === null ? 'source-arn-repeated' : 'source-arn-mismatch' }
    const account = single(headers, 'x-amz-source-account')
    if (account !== undefined && account !== want.account) return { ok: false, reason: 'source-account-mismatch' }
    return { ok: true, principal: `role/${got.name}` }
  }
}
