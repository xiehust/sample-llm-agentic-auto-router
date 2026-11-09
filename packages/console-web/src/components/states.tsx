// Common page states (4f §4: loading, empty, empty after filters, error with request id, forbidden, not found,
// sign-in expired, data delayed).

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Spinner from '@cloudscape-design/components/spinner'
import SpaceBetween from '@cloudscape-design/components/space-between'
import type { ReactNode } from 'react'
import { ApiError, SignInRequiredError } from '../api/client.ts'
import { useI18n } from '../i18n/I18n.tsx'
import type { MessageKey } from '../i18n/messages.ts'

export function Loading() {
  const { t } = useI18n()
  return <Box textAlign="center" padding="l" data-testid="state-loading"><Spinner size="large" /><Box variant="p" color="text-body-secondary">{t('state.loading')}</Box></Box>
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <Box textAlign="center" color="inherit" padding="l" data-testid="state-empty"><SpaceBetween size="s"><Box variant="strong">{title}</Box>{children}</SpaceBetween></Box>
}

export function EmptyFiltered({ onClear }: { onClear: () => void }) {
  const { t } = useI18n()
  return <Empty title={t('state.empty.filtered')}><Button onClick={onClear}>{t('common.clearFilters')}</Button></Empty>
}

export function Forbidden() {
  const { t } = useI18n()
  return <Box padding="l" data-testid="state-forbidden"><Alert type="error" header={t('state.forbidden.title')}>{t('state.forbidden.body')}</Alert></Box>
}

export function NotFound({ body }: { body?: MessageKey }) {
  const { t } = useI18n()
  return <Box padding="l" data-testid="state-not-found"><Alert type="warning" header={t('state.notFound.title')}>{t(body ?? 'state.notFound.body')}</Alert></Box>
}

/**
 * How a 404 reads on a page: 'not-found' for records; 'config' on the config pages, where it means no config can be
 * served (a console-api without the deploy defaults); 'error' for other singletons (gateway).
 */
export type NotFoundAs = 'not-found' | 'config' | 'error'

/** Flash text for a failed config mutation: 503 config-unavailable has its own copy (validate and activate send it). */
export function useMutationErrorText(): (e: unknown) => string {
  const { t } = useI18n()
  return (e) => (e instanceof ApiError && e.code === 'config-unavailable' ? t('ext.state.configUnavailable') : t('state.error.title'))
}

/** Renders an API error as the matching state; `inline` for card-level errors (the page still renders). */
export function ErrorState({ error, onRetry, inline, notFound = 'not-found' }: { error: unknown; onRetry?: () => void; inline?: boolean; notFound?: NotFoundAs }) {
  const { t } = useI18n()
  if (error instanceof ApiError && error.forbidden) return <Forbidden />
  // 503 config-unavailable (73): no active console version and config/baked.json unreadable.
  const config = error instanceof ApiError && (error.code === 'config-unavailable' || (error.notFound && notFound === 'config'))
  if (!config && error instanceof ApiError && error.notFound && notFound === 'not-found') return <NotFound />
  if (error instanceof SignInRequiredError) return <Alert type="warning">{t('state.sessionExpired')}</Alert>
  const requestId = error instanceof ApiError ? error.requestId ?? '—' : '—'
  return (
    <Box padding={inline ? 'n' : 'l'} data-testid="state-error">
      <Alert type="error" header={t('state.error.title')} action={onRetry ? <Button onClick={onRetry}>{t('common.retry')}</Button> : undefined}>
        {config ? t('ext.state.configUnavailable') : t('state.error.body', { requestId })}
      </Alert>
    </Box>
  )
}

/** Wraps a query's states. */
export function QueryView<T>({ q, children, empty, inline, notFound }: {
  q: { data: T | undefined; error: unknown; isPending: boolean; refetch: () => unknown }
  children: (data: T) => ReactNode
  empty?: (data: T) => ReactNode | false
  inline?: boolean
  notFound?: NotFoundAs
}) {
  if (q.isPending && q.data === undefined) return <Loading />
  if (q.error && q.data === undefined) return <ErrorState error={q.error} onRetry={() => void q.refetch()} inline={inline ?? false} {...(notFound ? { notFound } : {})} />
  if (q.data === undefined) return null
  const e = empty?.(q.data)
  if (e) return <>{e}</>
  return <>{children(q.data)}</>
}

export function Delayed({ seconds }: { seconds: number | undefined }) {
  const { t } = useI18n()
  if (seconds === undefined || seconds <= 300) return null
  return <Alert type="warning" data-testid="state-delayed">{t('state.delayed', { minutes: Math.round(seconds / 60) })}</Alert>
}
