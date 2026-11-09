// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy, securityHeaders, SPA_REWRITE_FUNCTION } from './security-headers.ts'

describe('security headers', () => {
  it('is a strict CSP: self scripts and styles, Trusted Types, no unsafe-*, the Cognito origin only', () => {
    const csp = contentSecurityPolicy({ cognitoOrigin: 'https://x.auth.r.amazoncognito.com/oauth2/token', upgradeInsecure: true })
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("style-src 'self'")
    expect(csp).toContain("connect-src 'self' https://x.auth.r.amazoncognito.com;")
    expect(csp).toContain("require-trusted-types-for 'script'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain('upgrade-insecure-requests')
    expect(csp).not.toMatch(/unsafe-(inline|eval|hashes)|\*/)
    expect(csp.length).toBeLessThan(1000)
  })
  it('sets the companion headers', () => {
    const h = securityHeaders({ cognitoOrigin: 'http://127.0.0.1:4311' })
    expect(h['x-frame-options']).toBe('DENY')
    expect(h['referrer-policy']).toBe('no-referrer')
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(h['content-security-policy']).not.toContain('upgrade-insecure-requests')
  })
  it('rewrites extensionless SPA paths to /index.html and leaves /api and files alone', () => {
    const handler = new Function(`${SPA_REWRITE_FUNCTION}; return handler`)() as (e: { request: { uri: string } }) => { uri: string }
    expect(handler({ request: { uri: '/decisions/r-1' } }).uri).toBe('/index.html')
    expect(handler({ request: { uri: '/assets/index-abc.js' } }).uri).toBe('/assets/index-abc.js')
    expect(handler({ request: { uri: '/config.json' } }).uri).toBe('/config.json')
    expect(handler({ request: { uri: '/api/me/profile' } }).uri).toBe('/api/me/profile')
  })
})
