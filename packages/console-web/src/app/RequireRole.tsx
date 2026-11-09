import type { Role } from '@auto-router/console-contract'
import type { ReactNode } from 'react'
import { useAuth } from '../auth/AuthContext.tsx'
import { Forbidden } from '../components/states.tsx'

/**
 * UI guard only: a member opening an admin route sees Forbidden (no redirect loop, nothing fetched). The API's group
 * check per route is the real control (design 0.7).
 */
export function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { role: mine } = useAuth()
  if (mine !== role) return <Forbidden />
  return <>{children}</>
}
