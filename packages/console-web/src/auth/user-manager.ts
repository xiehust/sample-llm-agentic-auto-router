// Cognito managed login with auth code + PKCE (S256) through oidc-client-ts (18-frontend-stack §2). Static metadata
// from /config.json: the browser makes no discovery call and talks to the Cognito domain only.

import { InMemoryWebStorage, UserManager, WebStorageStateStore } from 'oidc-client-ts'
import type { RuntimeConfig } from '../config/runtime-config.ts'

export const CALLBACK_PATH = '/auth/callback'
export const SIGNED_OUT_PATH = '/signed-out'

export function createUserManager(cfg: RuntimeConfig, origin: string = location.origin): UserManager {
  const d = cfg.cognitoDomain
  // Tokens: sessionStorage (default) or memory (deploy option). The PKCE verifier and state must survive the
  // redirect, so the state store is sessionStorage in both modes; oidc-client-ts removes it after the callback.
  const userStore = new WebStorageStateStore({ store: cfg.tokenStorage === 'memory' ? new InMemoryWebStorage() : sessionStorage, prefix: 'llmar.oidc.' })
  return new UserManager({
    authority: cfg.issuer,
    client_id: cfg.clientId,
    redirect_uri: origin + CALLBACK_PATH,
    post_logout_redirect_uri: origin + SIGNED_OUT_PATH,
    response_type: 'code',
    scope: cfg.scopes.join(' '),
    metadata: {
      issuer: cfg.issuer,
      authorization_endpoint: `${d}/oauth2/authorize`,
      token_endpoint: `${d}/oauth2/token`,
      revocation_endpoint: `${d}/oauth2/revoke`,
      userinfo_endpoint: `${d}/oauth2/userInfo`,
      end_session_endpoint: `${d}/logout`,
    },
    userStore,
    stateStore: new WebStorageStateStore({ store: sessionStorage, prefix: 'llmar.oidc.' }),
    loadUserInfo: false,
    // Refresh happens on demand before an API call (AuthSession.getAccessToken, one at a time). A second, timer-driven
    // renewal could spend the rotating refresh token twice, so automatic renewal stays off.
    automaticSilentRenew: false,
    revokeTokenTypes: ['refresh_token'],
    // The refresh token rotates (Cognito rotation); oidc-client-ts keeps the new one from each refresh response.
    fetchRequestCredentials: 'omit',
    monitorSession: false,
  })
}

/**
 * Cognito's /logout takes client_id + logout_uri, not the OIDC end-session parameters, so sign-out builds the URL
 * itself. logout_uri must be a registered sign-out URL of the app client.
 */
export function logoutUrl(cfg: RuntimeConfig, origin: string = location.origin): string {
  const u = new URL(`${cfg.cognitoDomain}/logout`)
  u.searchParams.set('client_id', cfg.clientId)
  u.searchParams.set('logout_uri', origin + SIGNED_OUT_PATH)
  return u.toString()
}
