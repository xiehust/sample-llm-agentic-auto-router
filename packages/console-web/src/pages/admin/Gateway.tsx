// Gateway (4f §4.11): read-only view of the deployed gateway. No edits from the console (design §4); every field
// names the CDK parameter that changes it.

import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import Header from '@cloudscape-design/components/header'
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import Table from '@cloudscape-design/components/table'
import { ApiError } from '../../api/client.ts'
import { useGateway } from '../../api/hooks.ts'
import { QueryView } from '../../components/states.tsx'
import { Mono, Time } from '../../components/values.tsx'
import { useI18n } from '../../i18n/I18n.tsx'

export default function Gateway() {
  const { t } = useI18n()
  const q = useGateway()
  const cdk = (field: string, p: Record<string, string>) => (p[field] ? t('gateway.cdkOnly', { parameter: p[field] }) : undefined)
  return (
    <ContentLayout header={<Header variant="h1" description={t('gateway.description')}>{t('gateway.title')}</Header>}>
      {q.error instanceof ApiError && q.error.code === 'gateway-unavailable'
        ? <div data-testid="state-error"><StatusIndicator type="error">{t('gateway.error', { code: q.error.message })}</StatusIndicator></div>
        : (
          <QueryView q={q} notFound="error">{(g) => (
            <SpaceBetween size="l">
              <Container>
                <KeyValuePairs columns={3} items={[
                  { label: t('gateway.url'), value: <Mono>{g.url}</Mono>, info: cdk('url', g.cdkParameters) },
                  { label: t('gateway.id'), value: <Mono>{g.id}</Mono> },
                  { label: t('gateway.status'), value: <StatusIndicator type={g.status === 'READY' ? 'success' : 'warning'}>{g.status}</StatusIndicator> },
                  { label: t('gateway.updated'), value: <Time iso={g.updatedAt} /> },
                  { label: t('gateway.authorizer.discovery'), value: <Mono>{g.authorizer.discoveryUrl}</Mono> },
                  { label: t('gateway.authorizer.scopes'), value: <SpaceBetween size="xxxs">{g.authorizer.allowedScopes.map((s) => <Mono key={s}>{s}</Mono>)}<span>{t('gateway.authorizer.scopesOnly')}</span></SpaceBetween>, info: cdk('authorizer', g.cdkParameters) },
                ].map((i) => ({ label: i.label, value: i.info ? <SpaceBetween size="xxxs">{i.value}<span style={{ fontSize: 12 }}>{i.info}</span></SpaceBetween> : i.value }))} />
              </Container>
              <Table header={<Header variant="h2" description={cdk('targets', g.cdkParameters)}>{t('gateway.targets')}</Header>} items={g.targets} ariaLabels={{ tableLabel: t('gateway.targets') }}
                columnDefinitions={[
                  { id: 'n', header: t('gateway.targets'), cell: (x) => <Mono>{x.name}</Mono>, isRowHeader: true },
                  { id: 'r', header: t('common.details'), cell: (x) => t(x.role === 'router' ? 'gateway.target.router' : 'gateway.target.fallback') },
                  { id: 'd', header: t('common.view'), cell: (x) => x.detail },
                  { id: 'm', header: t('getStarted.models.col.models'), cell: (x) => x.models?.join(', ') ?? '—' },
                ]} />
              <Table header={<Header variant="h2" description={cdk('rules', g.cdkParameters)}>{t('gateway.rules')}</Header>} items={g.rules} ariaLabels={{ tableLabel: t('gateway.rules') }}
                columnDefinitions={[
                  { id: 'p', header: '#', cell: (x) => x.priority, isRowHeader: true },
                  { id: 'm', header: t('gateway.rules'), cell: (x) => x.match },
                  { id: 't', header: t('gateway.targets'), cell: (x) => <Mono>{x.target}</Mono> },
                ]} />
              <Container header={<Header variant="h2" description={cdk('forwardedHeaders', g.cdkParameters)}>{t('gateway.headers')}</Header>}>
                <SpaceBetween size="xs">
                  <span>{t('gateway.fallbackChain')}: {g.fallbackChain.join(' → ')}</span>
                  <span>{g.forwardedHeaders.map((h) => <Mono key={h}>{h}</Mono>).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, ', ', x] : [x]), [])}</span>
                </SpaceBetween>
              </Container>
            </SpaceBetween>
          )}</QueryView>
        )}
    </ContentLayout>
  )
}
