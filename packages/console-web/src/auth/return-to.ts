// The path to return to after sign-in travels in oidc-client-ts `url_state`. It is accepted only as a same-origin
// path, so a crafted callback cannot send the user to another site (open redirect).

const FALLBACK = '/'
const AUTH_PATHS = ['/auth/callback', '/signed-out']

export function safeReturnTo(v: unknown): string {
  if (typeof v !== 'string' || v === '' || v.length > 2048) return FALLBACK
  if (!v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return FALLBACK
  if (/[\u0000-\u001f\\]/.test(v)) return FALLBACK
  let u: URL
  try { u = new URL(v, 'https://console.invalid') } catch { return FALLBACK }
  if (u.origin !== 'https://console.invalid') return FALLBACK
  if (AUTH_PATHS.includes(u.pathname)) return FALLBACK
  return u.pathname + u.search + u.hash
}
