// Claims read from the access token payload for the UI only (route guards, menus). Decoded, never verified here:
// the API's JWT authorizer verifies every call and the handlers re-check the group per route (design 0.7).

import type { Role } from '@auto-router/console-contract'

export interface AccessClaims {
  sub: string
  username?: string
  groups: string[]
  scope: string[]
  exp?: number
}

function b64urlJson(part: string): unknown {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
  const bin = atob(b64)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

export function decodeAccessClaims(token: string): AccessClaims | undefined {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return undefined
  try {
    const p = b64urlJson(parts[1]) as Record<string, unknown>
    if (typeof p.sub !== 'string') return undefined
    const groups = Array.isArray(p['cognito:groups']) ? (p['cognito:groups'] as unknown[]).filter((g): g is string => typeof g === 'string') : []
    const out: AccessClaims = { sub: p.sub, groups, scope: typeof p.scope === 'string' ? p.scope.split(' ').filter(Boolean) : [] }
    if (typeof p.username === 'string') out.username = p.username
    if (typeof p.exp === 'number') out.exp = p.exp
    return out
  } catch { return undefined }
}

/** admin wins over member; no console group → undefined (the UI shows auth.noRole). */
export function roleOf(groups: readonly string[]): Role | undefined {
  if (groups.includes('admin')) return 'admin'
  if (groups.includes('member')) return 'member'
  return undefined
}
