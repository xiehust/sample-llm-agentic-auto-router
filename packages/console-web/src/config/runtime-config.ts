// /config.json: the deployment values the SPA needs before sign-in (18-frontend-stack §4.2). Anonymous and public by
// design, so it holds no secrets and only what sign-in needs; Get started values come from /api/me/setup.

export interface RuntimeConfig {
  schemaVersion: 1
  region: string
  /** Issuer: https://cognito-idp.<region>.amazonaws.com/<userPoolId> (or the fake IdP's issuer locally). */
  issuer: string
  /** Managed login domain origin: https://<prefix>.auth.<region>.amazoncognito.com */
  cognitoDomain: string
  clientId: string
  scopes: string[]
  apiBase: string
  tokenStorage: 'session' | 'memory'
}

export class ConfigError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`invalid /config.json: ${issues.join('; ')}`)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function httpsOrLoopback(v: unknown): boolean {
  if (typeof v !== 'string') return false
  try {
    const u = new URL(v)
    if (u.username || u.password || u.search || u.hash) return false
    return u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1')
  } catch { return false }
}

/** Validates the parsed document; throws ConfigError listing every problem. */
export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  const issues: string[] = []
  if (!isObj(raw)) throw new ConfigError(['not a JSON object'])
  if (raw.schemaVersion !== 1) issues.push('schemaVersion must be 1')
  for (const k of ['region', 'clientId'] as const) if (typeof raw[k] !== 'string' || raw[k] === '') issues.push(`${k} must be a non-empty string`)
  for (const k of ['issuer', 'cognitoDomain'] as const) if (!httpsOrLoopback(raw[k])) issues.push(`${k} must be an https URL (or http://127.0.0.1 locally)`)
  if (!Array.isArray(raw.scopes) || raw.scopes.length === 0 || !raw.scopes.every((s) => typeof s === 'string' && /^[\w./:-]+$/.test(s))) {
    issues.push('scopes must be a non-empty list of scope names')
  }
  const apiBase = raw.apiBase ?? '/api'
  if (typeof apiBase !== 'string' || !apiBase.startsWith('/') || apiBase.startsWith('//')) issues.push('apiBase must be a same-origin path')
  const tokenStorage = raw.tokenStorage ?? 'session'
  if (tokenStorage !== 'session' && tokenStorage !== 'memory') issues.push("tokenStorage must be 'session' or 'memory'")
  if (issues.length) throw new ConfigError(issues)
  return {
    schemaVersion: 1,
    region: raw.region as string,
    issuer: (raw.issuer as string).replace(/\/$/, ''),
    cognitoDomain: new URL(raw.cognitoDomain as string).origin,
    clientId: raw.clientId as string,
    scopes: raw.scopes as string[],
    apiBase: (apiBase as string).replace(/\/$/, ''),
    tokenStorage: tokenStorage as RuntimeConfig['tokenStorage'],
  }
}

export async function loadRuntimeConfig(fetchImpl: typeof fetch = fetch): Promise<RuntimeConfig> {
  let res: Response
  try {
    res = await fetchImpl('/config.json', { cache: 'no-store', credentials: 'omit' })
  } catch (e) {
    throw new ConfigError([`could not fetch /config.json (${(e as Error).message})`])
  }
  if (!res.ok) throw new ConfigError([`/config.json answered ${res.status}`])
  let body: unknown
  try { body = await res.json() } catch { throw new ConfigError(['/config.json is not JSON']) }
  return parseRuntimeConfig(body)
}
