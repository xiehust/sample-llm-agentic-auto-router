import { useAuth } from '../auth/AuthContext.tsx'

/** Admins read the all-callers routes; members their own (/api/me/*). The server enforces the same split. */
export function useBase(): { base: 'me' | 'admin'; admin: boolean } {
  const { role } = useAuth()
  return role === 'admin' ? { base: 'admin', admin: true } : { base: 'me', admin: false }
}

/** Drops only the global. profile prefix: a geo profile (apac., jp., …, e.g. after a failover) stays distinct. */
export const shortModel = (id: string | undefined): string => (id ? id.replace(/^global\./, '') : '—')
