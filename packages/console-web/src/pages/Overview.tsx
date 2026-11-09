// Overview (4f §4.1): one look at how much, on what, and whether anything is wrong. Each card fails on its own.

import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import ColumnLayout from '@cloudscape-design/components/column-layout'
import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import Header from '@cloudscape-design/components/header'
import Link from '@cloudscape-design/components/link'
import ProgressBar from '@cloudscape-design/components/progress-bar'
import SegmentedControl from '@cloudscape-design/components/segmented-control'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import type { Profile, UsageReport } from '@auto-router/console-contract'
import type { ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useAudit, useBudgets, useConfig, useHealth, useProfile, useRecords, useSavings, useUsage } from '../api/hooks.ts'
import { Captions, Kpi, PageFooter } from '../components/blocks.tsx'
import { StackedDaily } from '../components/charts.tsx'
import { resolveRange } from '../components/range.tsx'
import { Delayed, Empty, ErrorState, Loading, QueryView } from '../components/states.tsx'
import { Caller, Pct, Time, Tokens, Usd, useTime, WithPii } from '../components/values.tsx'
import { useI18n } from '../i18n/I18n.tsx'
import { shortModel, useBase } from './scope.ts'

const tokensOf = (r: UsageReport['totals']) => r.tokens.uncached + r.tokens.cacheRead + Object.values(r.tokens.cacheWrite).reduce((a, b) => a + (b ?? 0), 0) + r.tokens.output

export default function Overview() {
  const { t } = useI18n()
  const { base, admin } = useBase()
  const nav = useNavigate()
  const [sp, setSp] = useSearchParams()
  const month = sp.get('month') === 'last' ? 'lastMonth' : 'thisMonth'
  const range = resolveRange(new URLSearchParams({ range: month }))
  const profile = useProfile()
  const usage = useUsage(base, { from: range.from, to: range.to, groupBy: admin ? 'caller' : 'model', stackBy: 'model' })
  const models = useUsage(base, admin ? { from: range.from, to: range.to, groupBy: 'model' } : undefined)
  const modelRows = admin ? models.data?.rows : usage.data?.rows
  const fmt = useTime()
  const recentRange = resolveRange(new URLSearchParams({ range: '30d' }))
  const recent = useRecords(base, { from: recentRange.fromIso, to: recentRange.toIso, limit: 100 })

  const header = (
    <Header variant="h1" actions={
      <SegmentedControl label={t('overview.title')} selectedId={month} onChange={(e) => setSp(e.detail.selectedId === 'lastMonth' ? { month: 'last' } : {}, { replace: true })}
        options={[{ id: 'thisMonth', text: t('overview.thisMonth') }, { id: 'lastMonth', text: t('overview.lastMonth') }]} />
    }>{t('overview.title')}</Header>
  )

  if (usage.isPending) return <ContentLayout header={header}><Loading /></ContentLayout>
  const empty = usage.data && usage.data.totals.requests === 0 && month === 'thisMonth' && !profile.data?.firstRequestAt
  if (empty) {
    return (
      <ContentLayout header={header}>
        <Container><Empty title={t(admin ? 'overview.empty.admin' : 'overview.empty.member')}><Button variant="primary" onClick={() => nav('/get-started')}>{t('overview.empty.cta')}</Button></Empty></Container>
      </ContentLayout>
    )
  }

  const sessions = [...new Map((recent.data?.items ?? []).filter((r) => r.session).map((r) => [r.session as string, r])).values()].slice(0, 5)
  return (
    <ContentLayout header={header}>
      <SpaceBetween size="l">
        <Delayed seconds={profile.data?.deployment.ingestLagSeconds} />
        <Container header={<Header variant="h2">{t(month === 'thisMonth' ? 'overview.thisMonth' : 'overview.lastMonth')}</Header>}>
          {usage.error ? <ErrorState error={usage.error} onRetry={() => void usage.refetch()} inline /> : usage.data && (
            <ColumnLayout columns={admin ? 4 : 4} variant="text-grid">
              <Kpi label={t('overview.kpi.cost')} value={<Usd v={usage.data.totals.cost.total} />} />
              <Kpi label={t('overview.kpi.requests')} value={usage.data.totals.requests} />
              <Kpi label={t('overview.kpi.tokens')} value={<Tokens v={tokensOf(usage.data.totals)} />} />
              {admin ? <ActiveCallers /> : <Kpi label={t('overview.kpi.hitRate')} value={<Pct v={usage.data.totals.hitRate} />} />}
            </ColumnLayout>
          )}
        </Container>
        {admin ? <NetSaving from={range.from} to={range.to} profile={profile.data} /> : <BudgetCard profile={profile.data} />}
        <ColumnLayout columns={2}>
          <Container header={<Header variant="h2">{t('overview.topModels')}</Header>}>
            {(modelRows ?? []).slice(0, 3).map((r) => (
              <Box key={r.key}><SpaceBetween direction="horizontal" size="xs"><span>{shortModel(r.key)}</span><Box variant="strong"><Usd v={r.cost.total} /></Box></SpaceBetween></Box>
            ))}
            {(modelRows ?? []).length === 0 && <Box color="text-body-secondary">{t('state.empty.range')}</Box>}
          </Container>
          {admin ? (
            <Container header={<Header variant="h2">{t('overview.topCallers')}</Header>}>
              {(usage.data?.rows ?? []).slice(0, 5).map((r) => (
                <Box key={r.key}><SpaceBetween direction="horizontal" size="xs"><Caller c={usage.data?.callers?.find((c) => c.key === r.key)} /><Box variant="strong"><Usd v={r.cost.total} /></Box></SpaceBetween></Box>
              ))}
            </Container>
          ) : (
            <Container header={<Header variant="h2">{t('overview.recentSessions')}</Header>}>
              <SpaceBetween size="xxs">
                {recent.data?.items[0] && <Box color="text-body-secondary">{t('overview.lastRequest', { time: fmt(recent.data.items[0].ts) })}</Box>}
                {sessions.map((s) => <Link key={s.session} href={`/sessions/${s.session}`} onFollow={(e) => { e.preventDefault(); nav(`/sessions/${s.session}`) }}>{s.session}</Link>)}
                {recent.isPending && <Loading />}
              </SpaceBetween>
            </Container>
          )}
        </ColumnLayout>
        {admin && usage.data && (
          <Container header={<Header variant="h2">{t('overview.costPerDay')}</Header>}>
            <QueryView q={models} inline>{(m) => <StackedDaily points={m.daily} from={range.from} to={range.to} metric="cost" label={t('overview.costPerDay')} seriesLabel={shortModel} />}</QueryView>
          </Container>
        )}
        {admin && <AdminOps />}
        <Captions items={[t('caption.scope'), usage.data && t('caption.listPrice', { region: usage.data.catalog.region, catalogVersion: usage.data.catalog.version })]} />
        {usage.data && <PageFooter region={usage.data.catalog.region} catalogVersion={usage.data.catalog.version} dataAsOf={usage.data.dataAsOf} />}
      </SpaceBetween>
    </ContentLayout>
  )
}

function BudgetCard({ profile }: { profile: Profile | undefined }) {
  const { t, f } = useI18n()
  const b = profile?.budget
  if (!b) return null
  const used = b.monthlyUsd > 0 ? b.spentUsd / b.monthlyUsd : 0
  return (
    <Container header={<Header variant="h2">{t('overview.budget.title')}</Header>}>
      <ProgressBar value={Math.min(100, Math.round(used * 100))} status={used >= 1 ? 'error' : 'in-progress'}
        label={t('overview.budget.used', { spent: f.usd(b.spentUsd), budget: f.usd(b.monthlyUsd) })}
        description={t('overview.budget.alertAt', { percent: Math.round(b.alertAt * 100) })} />
    </Container>
  )
}

function ActiveCallers() {
  const { t } = useI18n()
  const r = resolveRange(new URLSearchParams({ range: '7d' }))
  const q = useUsage('admin', { from: r.from, to: r.to, groupBy: 'caller' })
  return <Kpi label={t('overview.kpi.activeCallers')} value={q.data ? q.data.rows.filter((x) => x.key !== 'none' && x.requests > 0).length : '…'} />
}

function NetSaving({ from, to, profile }: { from: string; to: string; profile: Profile | undefined }) {
  const { t, f } = useI18n()
  const nav = useNavigate()
  const baseline = profile?.deployment.defaultBaseline ?? 'static'
  const s = useSavings('admin', { view: 'savings', from, to, baseline })
  const label = t(baseline === 'static' ? 'savings.baseline.static' : baseline === 'observe-default' ? 'savings.baseline.observeDefault' : baseline === 'standard' ? 'savings.baseline.standard' : 'savings.baseline.frontier')
  return (
    <Container header={<Header variant="h2" actions={<Button variant="link" onClick={() => nav('/savings')}>{t('nav.savings')}</Button>}>{t('overview.kpi.netSaving', { baseline: label })}</Header>}>
      <QueryView q={s} inline>{(d) => (
        <SpaceBetween size="s">
          <Kpi label={t('savings.kpi.net')} value={f.usdSigned(d.kpis.N)} tone={d.kpis.N < 0 ? 'negative' : undefined} help={d.kpis.N < 0 ? t('savings.kpi.netNegative') : d.kpis.rate !== undefined ? `${t('savings.kpi.rate')}: ${f.percent(d.kpis.rate)}` : undefined} />
          <Captions items={[t('savings.caption.listPrice', { catalogVersion: d.catalog.version }), t('savings.caption.sameUsage'), t('savings.caption.quality')]} />
        </SpaceBetween>
      )}</QueryView>
    </Container>
  )
}

function AdminOps() {
  const { t } = useI18n()
  const nav = useNavigate()
  const health = useHealth('24h')
  const config = useConfig()
  const budgets = useBudgets()
  const profile = useProfile()
  const day = resolveRange(new URLSearchParams({ range: '24h' }))
  const callers = useUsage('admin', { from: day.from, to: day.to, groupBy: 'caller' })
  const audit = useAudit({ from: resolveRange(new URLSearchParams({ range: '30d' })).from, to: day.to, limit: 3 })
  const alerts: ReactNode[] = []
  if (config.data?.router.status === 'rejected') alerts.push(t('overview.alert.configRejected', { version: config.data.router.reportedVersion ?? '?', active: config.data.active.version }))
  for (const b of budgets.data?.perPrincipal ?? []) if (b.spentUsd > b.budget.monthlyUsd) alerts.push(<WithPii kind="caller" text={t('overview.alert.budgetExceeded', { caller: b.caller.name ?? b.caller.key })} value={b.caller.name ?? b.caller.key} />)
  const lag = profile.data?.deployment.ingestLagSeconds
  if (lag !== undefined && lag > 300) alerts.push(t('overview.alert.ingestDelayed', { minutes: Math.round(lag / 60) }))
  const total = callers.data?.totals.requests ?? 0
  const none = callers.data?.rows.find((r) => r.key === 'none')?.requests ?? 0
  if (total > 0 && none / total > 0.05) alerts.push(t('overview.alert.unattributed', { percent: Math.round((none / total) * 100) }))
  const last = <T,>(xs: T[] | undefined) => xs?.at(-1)
  return (
    <ColumnLayout columns={3}>
      <Container header={<Header variant="h2" actions={<Button variant="link" onClick={() => nav('/admin/health')}>{t('nav.health')}</Button>}>{t('overview.health')}</Header>}>
        <QueryView q={health} inline>{(h) => (
          <SpaceBetween size="xxs">
            <StatusIndicator type={h.tasks.running >= h.tasks.desired && h.tasks.running > 0 ? 'success' : 'error'}>{t('health.tasks')}: {h.tasks.running} / {h.tasks.desired}</StatusIndicator>
            <span>{t('health.errors5xx')}: <Pct v={last(h.rate5xx)?.v} /></span>
            <span>{t('health.failovers')}: {(last(h.failovers)?.v ?? 0).toFixed(1)}</span>
            <span>{t('health.fallbackSigns')}: {h.fallbackSigns.router5xx}</span>
          </SpaceBetween>
        )}</QueryView>
      </Container>
      <Container header={<Header variant="h2">{t('overview.alerts')}</Header>}>
        <SpaceBetween size="xxs" >
          {alerts.length === 0 ? <StatusIndicator type="success">{t('overview.alert.none')}</StatusIndicator> : alerts.map((a, i) => <StatusIndicator key={i} type="warning">{a}</StatusIndicator>)}
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2" actions={<Button variant="link" onClick={() => nav('/admin/audit')}>{t('nav.audit')}</Button>}>{t('overview.recentChanges')}</Header>}>
        <QueryView q={audit} inline>{(a) => (
          <SpaceBetween size="xxs">{a.items.slice(0, 3).map((e) => <Box key={e.id}><Time iso={e.ts} /> · <span data-pii="actor">{e.actor.name ?? t('audit.actor.router')}</span> · {t(`audit.action.${e.action}`)} · <span data-pii="target">{e.target}</span></Box>)}</SpaceBetween>
        )}</QueryView>
      </Container>
    </ColumnLayout>
  )
}
