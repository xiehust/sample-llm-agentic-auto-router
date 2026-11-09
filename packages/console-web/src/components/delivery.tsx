// "Delivered to the router" state of config/active.json and identity/*.json (design §2.3a). The undelivered state
// is shown prominently with a button that writes the object again.

import Alert from '@cloudscape-design/components/alert'
import Button from '@cloudscape-design/components/button'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import type { Delivery } from '@auto-router/console-contract'
import { useRedeliverConfig, useRepublishIdentity } from '../api/hooks.ts'
import { useFlash } from '../app/flash.tsx'
import { useI18n } from '../i18n/I18n.tsx'
import { Mono } from './values.tsx'

export function DeliveryBanner({ d, kind }: { d: Delivery | undefined; kind: 'identity' | 'config' }) {
  const { t } = useI18n()
  const flash = useFlash()
  const republish = useRepublishIdentity()
  const redeliver = useRedeliverConfig()
  if (!d || d.state === 'delivered') return null
  const busy = republish.isPending || redeliver.isPending
  const run = () => (kind === 'identity' ? republish : redeliver).mutate(undefined, {
    onError: () => flash.push({ type: 'error', content: t('error.identity-delivery-failed') }),
  })
  if (d.state === 'pending') return <StatusIndicator type="in-progress" data-testid={`delivery-${kind}`}>{t('enum.deliveryState.pending')}</StatusIndicator>
  return (
    <Alert type="error" data-testid={`delivery-${kind}`} header={t('enum.deliveryState.notDelivered')}
      action={<Button loading={busy} onClick={run}>{t('delivery.republish')}</Button>}>
      {t('delivery.notDelivered.help')} {d.errorCode && <Mono>{d.errorCode}</Mono>}
    </Alert>
  )
}

export function DeliveryStatus({ d }: { d: Delivery | undefined }) {
  const { t } = useI18n()
  if (!d) return null
  return <StatusIndicator type={d.state === 'delivered' ? 'success' : d.state === 'pending' ? 'in-progress' : 'error'}>{t(`enum.deliveryState.${d.state}`)}</StatusIndicator>
}
