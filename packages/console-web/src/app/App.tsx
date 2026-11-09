import Button from '@cloudscape-design/components/button'
import { QueryClientProvider } from '@tanstack/react-query'
import { useMemo, type ReactNode } from 'react'
import { RouterProvider } from 'react-router'
import { ApiClient } from '../api/client.ts'
import { ApiCtx, createQueryClient } from '../api/hooks.ts'
import { AuthRoot } from '../auth/AuthContext.tsx'
import type { AuthSession } from '../auth/session.ts'
import { useI18n } from '../i18n/I18n.tsx'
import { FlashRoot, useFlash } from './flash.tsx'
import { createRouter } from './routes.tsx'

function Wiring({ session, children }: { session: AuthSession; children: ReactNode }) {
  const flash = useFlash()
  const { t, locale } = useI18n()
  const api = useMemo(() => new ApiClient(session, {
    onSignInRequired: () => flash.push({
      id: 'session-expired', type: 'warning', content: t('state.sessionExpired'),
      header: <Button variant="inline-link" onClick={() => void session.signIn(location.pathname + location.search, locale)}>{t('state.signIn')}</Button>,
    }),
  }), [session, flash, t, locale])
  return <ApiCtx.Provider value={api}>{children}</ApiCtx.Provider>
}

export function App({ session }: { session: AuthSession }) {
  const qc = useMemo(createQueryClient, [])
  const router = useMemo(createRouter, [])
  return (
    <QueryClientProvider client={qc}>
      <AuthRoot session={session}>
        <FlashRoot>
          <Wiring session={session}>
            <RouterProvider router={router} />
          </Wiring>
        </FlashRoot>
      </AuthRoot>
    </QueryClientProvider>
  )
}
