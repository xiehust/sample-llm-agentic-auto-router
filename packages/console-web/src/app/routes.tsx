// Route table (4f §3.4). Pages load lazily so the first route stays small (18-frontend-stack §1.2).

import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'
import { createBrowserRouter, useRouteError, type RouteObject } from 'react-router'
import { ErrorState, Loading, NotFound } from '../components/states.tsx'
import { ChunkReload, isChunkError } from './ChunkReload.tsx'
import { Layout } from './Layout.tsx'
import { RequireRole } from './RequireRole.tsx'

const page = (load: () => Promise<{ default: ComponentType }>) => {
  const C = lazy(load)
  return <Suspense fallback={<Loading />}><C /></Suspense>
}
const admin = (el: ReactNode) => <RequireRole role="admin">{el}</RequireRole>

function RouteError() {
  const e = useRouteError()
  return isChunkError(e) ? <ChunkReload /> : <ErrorState error={e} />
}

export const routes: RouteObject[] = [
  {
    element: <Layout />,
    errorElement: <RouteError />,
    children: [
      { errorElement: <RouteError />, children: [
        { index: true, element: page(() => import('../pages/Overview.tsx')) },
        { path: 'usage', element: page(() => import('../pages/Usage.tsx')) },
        { path: 'savings', element: page(() => import('../pages/Savings.tsx')) },
        { path: 'decisions', element: page(() => import('../pages/Decisions.tsx')) },
        { path: 'decisions/:reqId', element: page(() => import('../pages/DecisionDetail.tsx')) },
        { path: 'sessions/:session', element: page(() => import('../pages/Session.tsx')) },
        { path: 'get-started', element: page(() => import('../pages/GetStarted.tsx')) },
        { path: 'settings', element: page(() => import('../pages/Settings.tsx')) },
        { path: 'settings/deployment', element: admin(page(() => import('../pages/admin/DeploymentSettings.tsx'))) },
        { path: 'admin/members', element: admin(page(() => import('../pages/admin/Members.tsx'))) },
        { path: 'admin/members/:id', element: admin(page(() => import('../pages/admin/MemberDetail.tsx'))) },
        { path: 'admin/clients', element: admin(page(() => import('../pages/admin/Clients.tsx'))) },
        { path: 'admin/policy', element: admin(page(() => import('../pages/admin/Policy.tsx'))) },
        { path: 'admin/config/versions', element: admin(page(() => import('../pages/admin/Versions.tsx'))) },
        { path: 'admin/config/versions/:version', element: admin(page(() => import('../pages/admin/Versions.tsx'))) },
        { path: 'admin/assessor', element: admin(page(() => import('../pages/admin/Assessor.tsx'))) },
        { path: 'admin/gateway', element: admin(page(() => import('../pages/admin/Gateway.tsx'))) },
        { path: 'admin/health', element: admin(page(() => import('../pages/admin/Health.tsx'))) },
        { path: 'admin/audit', element: admin(page(() => import('../pages/admin/Audit.tsx'))) },
        { path: '*', element: <NotFound /> },
      ] },
    ],
  },
]

export const createRouter = () => createBrowserRouter(routes)
