// The SPA's sign-in session (18-frontend-stack §2.5): callback handling, single-flight token refresh, sign-out with
// refresh-token revocation and Cognito /logout, and cross-tab sign-out over a BroadcastChannel.

import type { User, UserManager } from 'oidc-client-ts'
import type { RuntimeConfig } from '../config/runtime-config.ts'
import { decodeAccessClaims, roleOf, type AccessClaims } from './claims.ts'
import { safeReturnTo } from './return-to.ts'
import { CALLBACK_PATH, createUserManager, logoutUrl, SIGNED_OUT_PATH } from './user-manager.ts'

export type InitResult =
  | { status: 'signed-in'; returnTo?: string }
  | { status: 'signed-out' }
  | { status: 'callback-error'; message: string }

export interface SessionDeps {
  userManager?: UserManager
  location?: Pick<Location, 'pathname' | 'search' | 'hash' | 'origin' | 'href'> & { assign(url: string): void }
  channel?: Pick<BroadcastChannel, 'postMessage' | 'addEventListener' | 'close'> | null
  now?: () => number
}

const CHANNEL = 'llmar-auth'
/**
 * One-shot marker for the signed-out page: "Sign out everywhere" also revoked the llmar CLI sign-in (4f). Kept in
 * this tab's sessionStorage, which survives the Cognito /logout round trip (the registered logout URL takes no query).
 */
export const SIGNED_OUT_EVERYWHERE_KEY = 'llmar.console.signedOutEverywhere'

/** Reads and clears the marker. */
export function takeSignedOutEverywhere(storage: Pick<Storage, 'getItem' | 'removeItem'> | undefined = globalThis.sessionStorage): boolean {
  try {
    const v = storage?.getItem(SIGNED_OUT_EVERYWHERE_KEY) === '1'
    storage?.removeItem(SIGNED_OUT_EVERYWHERE_KEY)
    return v
  } catch { return false }
}
/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_S = 60

export class AuthSession {
  readonly cfg: RuntimeConfig
  readonly um: UserManager
  private readonly loc: NonNullable<SessionDeps['location']>
  private readonly channel: SessionDeps['channel']
  private readonly now: () => number
  private user: User | null = null
  private refreshing: Promise<User | null> | undefined
  private listeners = new Set<() => void>()
  private expired = false

  constructor(cfg: RuntimeConfig, deps: SessionDeps = {}) {
    this.cfg = cfg
    this.loc = deps.location ?? window.location
    this.um = deps.userManager ?? createUserManager(cfg, this.loc.origin)
    this.now = deps.now ?? Date.now
    this.channel = deps.channel !== undefined ? deps.channel : typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null
    this.channel?.addEventListener('message', (e: Event) => {
      if ((e as MessageEvent).data === 'signout') void this.um.removeUser().then(() => { this.user = null; this.loc.assign(SIGNED_OUT_PATH) })
    })
    this.um.events.addUserLoaded((u) => { this.user = u; this.expired = false; this.emit() })
    this.um.events.addUserUnloaded(() => { this.user = null; this.emit() })
    this.um.events.addSilentRenewError(() => { this.expired = true; this.emit() })
  }

  /** Handles /auth/callback, else restores a stored user. Never redirects by itself. */
  async init(): Promise<InitResult> {
    if (this.loc.pathname === CALLBACK_PATH) {
      try {
        const u = await this.um.signinCallback(this.loc.href)
        this.user = u ?? (await this.um.getUser())
        return { status: 'signed-in', returnTo: safeReturnTo(u?.url_state) }
      } catch (e) {
        return { status: 'callback-error', message: (e as Error).message }
      }
    }
    this.user = await this.um.getUser()
    if (this.user && this.user.expired) {
      const u = await this.refresh()
      if (!u) return { status: 'signed-out' }
    }
    return this.user ? { status: 'signed-in' } : { status: 'signed-out' }
  }

  get claims(): AccessClaims | undefined {
    return this.user?.access_token ? decodeAccessClaims(this.user.access_token) : undefined
  }

  get role() { return roleOf(this.claims?.groups ?? []) }

  get isExpired(): boolean { return this.expired }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  private emit(): void { for (const fn of this.listeners) fn() }

  /** A valid access token, refreshed when it expires within a minute (one refresh at a time). */
  async getAccessToken(force = false): Promise<string | undefined> {
    const u = this.user
    if (!u) return undefined
    const left = (u.expires_at ?? 0) - this.now() / 1000
    if (!force && left > REFRESH_MARGIN_S) return u.access_token
    const fresh = await this.refresh()
    return fresh?.access_token
  }

  private refresh(): Promise<User | null> {
    this.refreshing ??= (async () => {
      try {
        if (!this.user?.refresh_token) throw new Error('no refresh token')
        const u = await this.um.signinSilent()
        this.user = u
        this.expired = false
        return u
      } catch {
        this.expired = true
        this.emit()
        return null
      } finally {
        this.refreshing = undefined
      }
    })()
    return this.refreshing
  }

  /** Redirects to managed login, in the UI language, returning to `returnTo` afterwards. */
  async signIn(returnTo: string, lang: string): Promise<void> {
    await this.um.signinRedirect({ url_state: safeReturnTo(returnTo), extraQueryParams: { lang } })
  }

  /**
   * Other tabs first, then revoke (best effort), forget, and clear the managed-login cookie via /logout.
   * `everywhere`: the API already revoked every refresh token of the account; the signed-out page says so.
   */
  async signOut(opts: { everywhere?: boolean } = {}): Promise<void> {
    if (opts.everywhere) { try { sessionStorage.setItem(SIGNED_OUT_EVERYWHERE_KEY, '1') } catch { /* storage blocked */ } }
    try { this.channel?.postMessage('signout') } catch { /* channel closed */ }
    try { await this.um.revokeTokens(['refresh_token']) } catch { /* revocation is best effort */ }
    await this.um.removeUser()
    this.user = null
    this.loc.assign(logoutUrl(this.cfg, this.loc.origin))
  }
}
