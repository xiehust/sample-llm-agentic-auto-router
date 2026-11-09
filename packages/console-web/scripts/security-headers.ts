// One definition of the console's response headers, used by `vite preview` (so the Playwright smoke runs under the
// production policy) and by the CDK response-headers policy (infra imports this module). 18-frontend-stack §1.6, §4.4.
//
// The policy was measured against the Cloudscape build: no inline scripts or styles, no eval, no runtime <style>
// injection, Trusted Types enforced. `font-src data:` is needed for the Open Sans faces embedded in
// @cloudscape-design/global-styles/index.css.

export interface HeaderOptions {
  /** Origin of the Cognito domain the SPA calls for /oauth2/token and /oauth2/revoke, e.g. https://x.auth.r.amazoncognito.com */
  cognitoOrigin: string
  /** Add upgrade-insecure-requests (CloudFront, HTTPS only). Off for local preview over http://127.0.0.1. */
  upgradeInsecure?: boolean
  /** cognitoOrigin is already an origin (e.g. a CDK token that resolves to one at deploy): do not parse it. */
  originIsResolved?: boolean
}

export function contentSecurityPolicy(o: HeaderOptions): string {
  const origin = o.originIsResolved ? o.cognitoOrigin : new URL(o.cognitoOrigin).origin
  const directives = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self' data:",
    `connect-src 'self' ${origin}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ]
  if (o.upgradeInsecure) directives.push('upgrade-insecure-requests')
  return directives.join('; ')
}

export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'

/** Header name → value for the SPA (default CloudFront behavior and vite preview). */
export function securityHeaders(o: HeaderOptions): Record<string, string> {
  return {
    'content-security-policy': contentSecurityPolicy(o),
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': PERMISSIONS_POLICY,
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  }
}

/** Cache-Control per object: hashed assets are immutable; the entry points always revalidate. */
export const CACHE_CONTROL = {
  assets: 'public, max-age=31536000, immutable',
  entry: 'no-cache',
} as const

/**
 * CloudFront Function (cloudfront-js-2.0, viewer request, default behavior only): extensionless paths are SPA routes
 * and get /index.html. Distribution-wide custom error responses are not used because they would also rewrite the
 * /api/* behavior's 403/404 answers into index.html with status 200.
 */
export const SPA_REWRITE_FUNCTION = `function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var last = uri.substring(uri.lastIndexOf('/') + 1);
  if (uri.indexOf('/api/') !== 0 && last.indexOf('.') === -1) request.uri = '/index.html';
  return request;
}`
