import type { Role } from '@auto-router/console-contract'
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { AccessClaims } from './claims.ts'
import type { AuthSession } from './session.ts'

export interface AuthState {
  session: AuthSession
  claims: AccessClaims | undefined
  role: Role | undefined
  expired: boolean
}

const Ctx = createContext<AuthSession | undefined>(undefined)

export function AuthRoot({ session, children }: { session: AuthSession; children: ReactNode }) {
  return <Ctx.Provider value={session}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const session = useContext(Ctx)
  if (!session) throw new Error('useAuth outside <AuthRoot>')
  // Re-render on user load / unload / renew failure.
  useSyncExternalStore((cb) => session.subscribe(cb), () => `${session.claims?.sub}|${session.claims?.exp}|${session.isExpired}`)
  return { session, claims: session.claims, role: session.role, expired: session.isExpired }
}
