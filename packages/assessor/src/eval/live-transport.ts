// Eval-only live transport: SigV4-signed HTTPS to bedrock-runtime (model invocations only). Not exported from index.ts.
// Uses the router's signer stack (devDependencies). Credentials come from the default provider chain (credential_process).
import { Sha256 } from '@aws-crypto/sha256-js'
import { defaultProvider } from '@aws-sdk/credential-provider-node'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import type { Transport } from '../transport.ts'

/** The only bedrock-runtime paths the live transport will sign: the three model-invocation APIs the adapters use. */
export const INVOKE_PATHS: ReadonlySet<string> = new Set(['/openai/v1/responses', '/openai/v1/chat/completions', '/anthropic/v1/messages'])

type Creds = ReturnType<typeof defaultProvider>

function signer(service: string, region: string, credentials: Creds): SignatureV4 {
  return new SignatureV4({ service, region, credentials, sha256: Sha256 })
}

async function signedFetch(sig: SignatureV4, host: string, path: string, body: string, headers: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; body: string }> {
  const req = new HttpRequest({ method: 'POST', protocol: 'https:', hostname: host, path, body, headers: { ...headers, host } })
  const signed = await sig.sign(req)
  const res = await fetch(`https://${host}${path}`, { method: 'POST', headers: signed.headers as Record<string, string>, body, ...(signal ? { signal } : {}) })
  return { status: res.status, body: await res.text() }
}

/**
 * Refuses to run unless the caller account equals LLMAR_SPIKE_ACCOUNT (the account the user authorized for this
 * project). The id itself is never logged or written anywhere.
 */
export async function assertAuthorizedAccount(credentials: Creds, region: string): Promise<void> {
  const expected = process.env.LLMAR_SPIKE_ACCOUNT?.trim()
  if (!expected) throw new Error('LLMAR_SPIKE_ACCOUNT is unset (source scripts/local.env); refusing to call AWS')
  const host = `sts.${region}.amazonaws.com`
  const r = await signedFetch(signer('sts', region, credentials), host, '/', 'Action=GetCallerIdentity&Version=2011-06-15',
    { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' })
  const m = /<Account>(\d{12})<\/Account>/.exec(r.body)
  if (r.status !== 200 || !m) throw new Error(`caller identity check failed (HTTP ${r.status}); refusing to call Bedrock`)
  if (m[1] !== expected) throw new Error('caller account does not equal LLMAR_SPIKE_ACCOUNT; refusing to call Bedrock')
}

/** Live transport for bedrock-runtime in `region` (from --region or the catalog's region; no built-in default). */
export async function createLiveTransport(region: string): Promise<Transport> {
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error(`live transport: not a region name: ${region}`)
  const credentials = defaultProvider()
  await assertAuthorizedAccount(credentials, region)
  const sig = signer('bedrock', region, credentials)
  const host = `bedrock-runtime.${region}.amazonaws.com`
  return async (req) => {
    if (!INVOKE_PATHS.has(req.path)) {
      throw new Error(`live transport: path not allowed: ${req.path}`) // model invocations only
    }
    return signedFetch(sig, host, req.path, req.body, { 'content-type': 'application/json', ...req.headers }, req.signal)
  }
}
