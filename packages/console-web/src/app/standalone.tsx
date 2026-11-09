// Pages rendered outside the signed-in app: invalid /config.json, signing in, callback failure, signed out. None of
// them redirects by itself except "signing in" (so there is never a sign-in loop).

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Container from '@cloudscape-design/components/container'
import Header from '@cloudscape-design/components/header'
import SpaceBetween from '@cloudscape-design/components/space-between'
import Spinner from '@cloudscape-design/components/spinner'
import type { ReactNode } from 'react'
import { ConfigError } from '../config/runtime-config.ts'
import { useI18n } from '../i18n/I18n.tsx'

function Frame({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return (
    <Box padding={{ vertical: 'xxxl', horizontal: 'l' }}>
      <div style={{ maxWidth: 640, margin: '0 auto' }}>
        <Container header={<Header variant="h1">{t('app.title')} · {t('app.subtitle')}</Header>}>{children}</Container>
      </div>
    </Box>
  )
}

export function ConfigErrorPage({ error }: { error: unknown }) {
  const { t } = useI18n()
  const issues = error instanceof ConfigError ? error.issues : [String(error)]
  return (
    <Frame>
      <Alert type="error" header={t('ext.configError.title')}>
        <SpaceBetween size="xs">
          <span>{t('ext.configError.body')}</span>
          <Box variant="code">{issues.join('; ')}</Box>
        </SpaceBetween>
      </Alert>
    </Frame>
  )
}

export function SigningInPage() {
  const { t } = useI18n()
  return <Frame><Box textAlign="center" data-testid="signing-in"><Spinner size="large" /><Box variant="p">{t('auth.signingIn')}</Box></Box></Frame>
}

export function SignedOutPage({ onSignIn, everywhere }: { onSignIn: () => void; everywhere?: boolean }) {
  const { t } = useI18n()
  return (
    <Frame>
      <SpaceBetween size="m">
        <Box variant="p" data-testid="signed-out">{t('auth.signedOut')}</Box>
        {everywhere && <Alert type="info" data-testid="signed-out-everywhere">{t('settings.signOutEverywhere.done')}</Alert>}
        <Button variant="primary" onClick={onSignIn}>{t('auth.signIn')}</Button>
      </SpaceBetween>
    </Frame>
  )
}

export function CallbackErrorPage({ message, onSignIn }: { message: string; onSignIn: () => void }) {
  const { t } = useI18n()
  return (
    <Frame>
      <SpaceBetween size="m">
        <Alert type="error" header={t('auth.error', { code: 'callback' })}><Box variant="code">{message}</Box></Alert>
        <Button variant="primary" onClick={onSignIn}>{t('auth.signIn')}</Button>
      </SpaceBetween>
    </Frame>
  )
}
