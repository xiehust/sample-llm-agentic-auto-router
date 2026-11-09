// Health (4f §4.13): is the router serving well right now. EMF metrics (namespace LlmAutoRouter) and ECS; "signs of
// gateway fallback" are proxies (the gateway publishes no fallback count).

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import ColumnLayout from '@cloudscape-design/components/column-layout'
import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import Header from '@cloudscape-design/components/header'
import SegmentedControl from '@cloudscape-design/components/segmented-control'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import type { HealthRange } from '@auto-router/console-contract'
import { ApiError } from '../../api/client.ts'
import { useHealth } from '../../api/hooks.ts'
import { TimeLines } from '../../components/charts.tsx'
import { Kpi } from '../../components/blocks.tsx'
import { useParam } from '../../components/filters.tsx'
import { QueryView } from '../../components/states.tsx'
import { Mono, Time } from '../../components/values.tsx'
import { useI18n } from '../../i18n/I18n.tsx'

const RANGES: HealthRange[] = ['1h', '6h', '24h', '7d']

export default function Health() {
  const { t, f } = useI18n()
  const [range, setRange] = useParam<HealthRange>('range', RANGES, '24h')
  const q = useHealth(range)
  const pct = (v: number) => f.percent(v)
  return (
    <ContentLayout header={<Header variant="h1" description={t('health.description')} actions={
      <SegmentedControl label={t('common.dateRange')} selectedId={range} onChange={(e) => setRange(e.detail.selectedId as HealthRange)}
        options={RANGES.map((r) => ({ id: r, text: t(r === '1h' ? 'common.range.1h' : r === '6h' ? 'common.range.6h' : r === '24h' ? 'common.range.24h' : 'common.range.7d') }))} />
    }>{t('health.title')}</Header>}>
      {q.error instanceof ApiError && q.error.code === 'metrics-unavailable' ? <Alert type="error">{t('health.error')}</Alert> : (
        <QueryView q={q}>{(h) => (
          <SpaceBetween size="l">
            {h.tasks.running === 0 && <Alert type="error">{t('health.tasksZero')}</Alert>}
            <Container>
              <ColumnLayout columns={4} variant="text-grid">
                <Kpi label={t('health.tasks')} value={<StatusIndicator type={h.tasks.running >= h.tasks.desired && h.tasks.running > 0 ? 'success' : 'error'}>{h.tasks.running} / {h.tasks.desired}</StatusIndicator>} />
                <Kpi label={t('health.config')} value={<Mono>{h.config.reportedVersion ?? h.config.activeVersion}</Mono>} help={h.config.rejections > 0 ? `${t('health.configRejected')}: ${h.config.rejections}` : undefined} />
                <Kpi label={t('health.ingestLag')} value={h.ingestLagSeconds === undefined ? '—' : `${Math.round(h.ingestLagSeconds)} s`} />
                <Kpi label={t('health.fallbackSigns')} value={`${h.fallbackSigns.router5xx} · ${h.fallbackSigns.unhealthyTargets}${h.fallbackSigns.tasksBelowDesired ? ' · !' : ''}`} help={t('health.fallbackSigns.help')} />
              </ColumnLayout>
            </Container>
            <ColumnLayout columns={2}>
              <Container header={<Header variant="h2">{t('health.requestRate')}</Header>}><TimeLines label={t('health.requestRate')} lines={[{ title: t('health.requestRate'), data: h.requestsPerMin }]} format={(v) => f.int(v)} /></Container>
              <Container header={<Header variant="h2">{`${t('health.errors4xx')} · ${t('health.errors5xx')}`}</Header>}><TimeLines label={t('health.errors5xx')} lines={[{ title: t('health.errors4xx'), data: h.rate4xx }, { title: t('health.errors5xx'), data: h.rate5xx }]} format={pct} /></Container>
              <Container header={<Header variant="h2">{t('health.overhead')}</Header>}><TimeLines label={t('health.overhead')} lines={[{ title: 'p50', data: h.overheadP50 }, { title: 'p99', data: h.overheadP99 }]} format={(v) => f.ms(v)} /></Container>
              <Container header={<Header variant="h2">{t('health.ttfb')}</Header>}><TimeLines label={t('health.ttfb')} lines={[{ title: 'p50', data: h.ttfbP50 }, { title: 'p99', data: h.ttfbP99 }]} format={(v) => f.ms(v)} /></Container>
              <Container header={<Header variant="h2">{t('health.hitRate')}</Header>}><TimeLines label={t('health.hitRate')} lines={[{ title: t('health.hitRate'), data: h.hitRate }]} format={pct} /></Container>
              <Container header={<Header variant="h2">{`${t('health.failovers')} · ${t('health.switches')}`}</Header>}><TimeLines label={t('health.failovers')} lines={[{ title: t('health.failovers'), data: h.failovers }, { title: t('health.switches'), data: h.switches }]} format={(v) => v.toFixed(1)} /></Container>
            </ColumnLayout>
            <ColumnLayout columns={3}>
              <Container header={<Header variant="h2">{t('health.misses')}</Header>}>
                <SpaceBetween size="xxs">{Object.entries(h.missesByReason).map(([k, v]) => <Box key={k}>{t(`enum.missReason.${k as 'model_changed'}`)}: {f.int(v ?? 0)}</Box>)}</SpaceBetween>
              </Container>
              <Container header={<Header variant="h2">{t('health.assessor')}</Header>}>
                <SpaceBetween size="xxs">
                  <Box>p50 {h.assessor.latencyP50Ms !== undefined ? f.ms(h.assessor.latencyP50Ms) : '—'} · p95 {h.assessor.latencyP95Ms !== undefined ? f.ms(h.assessor.latencyP95Ms) : '—'}</Box>
                  <Box>{t('assessor.stats.unavailable')}: {h.assessor.unavailableRate !== undefined ? f.percent(h.assessor.unavailableRate) : '—'}</Box>
                </SpaceBetween>
              </Container>
              <Container header={<Header variant="h2">{t('health.alarms')}</Header>}>
                <SpaceBetween size="xxs">
                  {h.alarms.filter((a) => a.state === 'ALARM').length === 0 && <StatusIndicator type="success">{t('health.alarms.none')}</StatusIndicator>}
                  {h.alarms.map((a) => <StatusIndicator key={a.name} type={a.state === 'ALARM' ? 'error' : a.state === 'OK' ? 'success' : 'pending'}><Mono>{a.name}</Mono> <Time iso={a.since} /></StatusIndicator>)}
                </SpaceBetween>
              </Container>
            </ColumnLayout>
          </SpaceBetween>
        )}</QueryView>
      )}
    </ContentLayout>
  )
}
