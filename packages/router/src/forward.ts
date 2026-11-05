// Upstream call to bedrock-runtime (design §2.1 forward.ts): SigV4 (service bedrock, signed payload) + fetch.
import { createHash, createHmac, type Hash, type Hmac } from 'node:crypto'
import { defaultProvider } from '@aws-sdk/credential-provider-node'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'

/** Signs a request and returns the headers to send (including `authorization`). Injected so tests never sign. */
export interface Signer {
  sign(req: { method: string; url: URL; headers: Record<string, string>; body: Uint8Array }): Promise<Record<string, string>>
}

/**
 * SHA-256 / HMAC-SHA256 for the signer, backed by node:crypto. The pure-JS hash would cost tens of ms on a
 * 16 MiB body (N1 budget), so this small adapter implements the smithy Checksum interface instead.
 */
type SourceData = string | ArrayBuffer | ArrayBufferView
const bytes = (d: SourceData): string | Uint8Array =>
  typeof d === 'string' ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength)

class NodeSha256 {
  private h: Hash | Hmac
  private readonly secret: string | Uint8Array | undefined
  constructor(secret?: SourceData) {
    this.secret = secret === undefined ? undefined : bytes(secret)
    this.h = this.secret === undefined ? createHash('sha256') : createHmac('sha256', this.secret)
  }
  update(data: SourceData): void { this.h.update(bytes(data)) }
  async digest(): Promise<Uint8Array> { return new Uint8Array(this.h.digest()) }
  reset(): void { this.h = this.secret === undefined ? createHash('sha256') : createHmac('sha256', this.secret) }
}

/** Task-role credentials through the default provider chain (ECS container endpoint in the task), with refresh. */
export function createSigV4Signer(region: string, credentials = defaultProvider()): Signer {
  const sig = new SignatureV4({ service: 'bedrock', region, credentials, sha256: NodeSha256 })
  return {
    async sign({ method, url, headers, body }) {
      const req = new HttpRequest({
        method, protocol: url.protocol, hostname: url.hostname, ...(url.port ? { port: Number(url.port) } : {}),
        path: url.pathname, headers: { ...headers, host: url.host }, body,
      })
      const signed = await sig.sign(req)
      return signed.headers as Record<string, string>
    },
  }
}

/** Client headers relayed upstream. Credentials, cookies and hop headers are never forwarded. */
const UPSTREAM_HEADERS = ['anthropic-version', 'anthropic-beta', 'openai-beta'] as const

export function upstreamHeaders(client: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'accept-encoding': 'identity' }
  for (const name of UPSTREAM_HEADERS) {
    const v = client[name]
    if (typeof v === 'string') out[name] = v
  }
  return out
}

export interface ForwardOptions {
  upstream: URL
  path: string
  body: Buffer
  headers: Record<string, string>
  signer: Signer
  signal: AbortSignal
  fetchImpl?: typeof fetch
}

/** Signs and sends one attempt. Rejects on network errors; the caller decides about failover. */
export async function forward(o: ForwardOptions): Promise<Response> {
  const url = new URL(o.path, o.upstream)
  const signed = await o.signer.sign({ method: 'POST', url, headers: o.headers, body: o.body })
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(signed)) if (k.toLowerCase() !== 'host') headers[k] = v
  return (o.fetchImpl ?? fetch)(url, { method: 'POST', headers, body: o.body, signal: o.signal, redirect: 'manual' })
}

/**
 * Seam for the tier assessor (@auto-router/assessor createAssessor({ transport })): a signed POST to
 * bedrock-runtime returning status and text. The assessor adapts this to its Transport type.
 */
export function createBedrockPost(upstream: URL, signer: Signer, fetchImpl: typeof fetch = fetch) {
  return async (path: string, body: string, extraHeaders: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; body: string }> => {
    const res = await forward({
      upstream, path, body: Buffer.from(body, 'utf8'), headers: { ...upstreamHeaders({}), ...extraHeaders }, signer,
      signal: signal ?? AbortSignal.timeout(10_000), fetchImpl,
    })
    return { status: res.status, body: await res.text() }
  }
}
