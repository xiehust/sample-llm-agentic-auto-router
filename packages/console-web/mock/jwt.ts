// HS256 tokens for the local fake IdP and mock API only (one random key per process, never persisted). The mock
// API verifies signature, expiry, token_use, scope and client, like the HTTP API JWT authorizer it stands in for.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url')

export class JwtKey {
  private readonly key = randomBytes(32)

  sign(payload: Record<string, unknown>): string {
    const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'mock' }))
    const body = b64url(JSON.stringify(payload))
    const sig = createHmac('sha256', this.key).update(`${head}.${body}`).digest('base64url')
    return `${head}.${body}.${sig}`
  }

  /** The payload when the signature matches and the token is unexpired; undefined otherwise. */
  verify(token: string, nowS: number = Math.floor(Date.now() / 1000)): Record<string, unknown> | undefined {
    const parts = token.split('.')
    if (parts.length !== 3) return undefined
    const [head, body, sig] = parts as [string, string, string]
    const want = createHmac('sha256', this.key).update(`${head}.${body}`).digest()
    let got: Buffer
    try { got = Buffer.from(sig, 'base64url') } catch { return undefined }
    if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined
    try {
      const h = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as Record<string, unknown>
      if (h.alg !== 'HS256') return undefined
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
      if (typeof p.exp !== 'number' || p.exp <= nowS) return undefined
      if (typeof p.nbf === 'number' && p.nbf > nowS) return undefined
      return p
    } catch { return undefined }
  }
}
