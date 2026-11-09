// Savings (4f §4.3, 0d §1 as frozen in design 0.11): what routing changed in list-price cost against a baseline,
// decomposed, with the mandatory captions always visible.

import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import ColumnLayout from '@cloudscape-design/components/column-layout'
import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import ExpandableSection from '@cloudscape-design/components/expandable-section'
import Header from '@cloudscape-design/components/header'
import Link from '@cloudscape-design/components/link'
import SpaceBetween from '@cloudscape-design/components/space-between'
import Table from '@cloudscape-design/components/table'
import Tabs from '@cloudscape-design/components/tabs'
import type { Baseline, Dialect, SavingsBlock, SavingsReport, SavingsRow, Tier } from '@auto-router/console-contract'
import { useSearchParams } from 'react-router'
import { useProfile, useSavings } from '../api/hooks.ts'
import { Captions, ChartBox, Kpi, PageFooter } from '../components/blocks.tsx'
import { DailyLine } from '../components/charts.tsx'
import { download, toCsv } from '../components/csv.ts'
import { ChoiceFilter, ListFilter, useListParam, useParam } from '../components/filters.tsx'
import { RangeControl, useRange } from '../components/range.tsx'
import { Empty, QueryView } from '../components/states.tsx'
import { Caller, Pii } from '../components/values.tsx'
import { HARBOR_SUMMARY_PATH, repoFileUrl } from '../config/links.ts'
import { useI18n } from '../i18n/I18n.tsx'
import type { MessageKey } from '../i18n/messages.ts'
import { shortModel, useBase } from './scope.ts'

const BASELINES: Baseline[] = ['static', 'standard', 'frontier', 'observe-default']
const BASE_LABEL: Record<Baseline, MessageKey> = { static: 'savings.baseline.static', standard: 'savings.baseline.standard', frontier: 'savings.baseline.frontier', 'observe-default': 'savings.baseline.observeDefault' }
const TIERS: Tier[] = ['fast', 'standard', 'frontier']
const DIALECTS: Dialect[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
type Group = 'model' | 'dialect' | 'caller'

export default function Savings() {
  const { t, f } = useI18n()
  const { base, admin } = useBase()
  const [range, setRange] = useRange()
  const profile = useProfile()
  const [sp, setSp] = useSearchParams()
  const fallback = profile.data?.deployment.defaultBaseline ?? 'static'
  const [baseline, setBaseline] = useParam<Baseline>('baseline', BASELINES, fallback)
  const [groupBy, setGroupBy] = useParam<Group>('groupBy', admin ? ['model', 'dialect', 'caller'] : ['model', 'dialect'], 'model')
  const [dialect, setDialect] = useListParam('dialect')
  const [caller] = useListParam('caller')
  const tab = sp.get('tab') === 'projected' ? 'projected' : 'actual'
  const q = useSavings(base, { view: 'savings', from: range.from, to: range.to, baseline, groupBy, ...(dialect.length ? { dialect: dialect as Dialect[] } : {}), ...(admin && caller.length ? { caller } : {}) })

  const keyLabel = (k: string, rep: SavingsReport) => (groupBy === 'model' ? shortModel(k) : groupBy === 'dialect' ? t(`enum.dialect.${k as Dialect}`) : <Caller c={rep.callers?.find((c) => c.key === k)} />)
  const evidence = repoFileUrl(HARBOR_SUMMARY_PATH)

  const blockView = (b: SavingsBlock, rep: SavingsReport, projected: boolean) => (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2" description={t('savings.kpi.netFormula')}>{projected ? t('savings.tab.projected') : t('savings.tab.actual')}</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          <Kpi label={t('savings.kpi.actual')} value={f.usd(b.kpis.A)} />
          <Kpi label={t('savings.kpi.baseline')} value={f.usd(b.kpis.B)} />
          <Kpi label={t('savings.kpi.net')} value={f.usdSigned(b.kpis.N)} tone={b.kpis.N < 0 ? 'negative' : undefined} help={b.kpis.N < 0 ? t('savings.kpi.netNegative') : undefined} />
          <Kpi label={t('savings.kpi.rate')} value={b.kpis.rate === undefined ? t('common.notAvailable') : f.percent(b.kpis.rate)} tone={(b.kpis.rate ?? 0) < 0 ? 'negative' : undefined} />
          <Kpi label={t('savings.kpi.routing')} value={f.usdSigned(b.kpis.R)} help={t('savings.kpi.routing.help')} />
          <Kpi label={t('savings.kpi.switchPenalty')} value={f.usd(b.kpis.S)} help={t('savings.kpi.switchPenalty.help')} />
          <Kpi label={t('savings.kpi.assessor')} value={f.usd(b.kpis.X)} help={t('savings.kpi.assessor.help')} />
          {!projected && <Kpi label={t('savings.kpi.cache')} value={f.usdSigned(rep.promptCacheSaving)} help={t('savings.kpi.cache.help')} />}
        </ColumnLayout>
      </Container>
      <ColumnLayout columns={2}>
        <Container header={<Header variant="h2" description={t('savings.matrix.help')}>{t('savings.matrix.title')}</Header>}>
          <Table
            variant="embedded"
            ariaLabels={{ tableLabel: t('savings.matrix.title') }}
            columnDefinitions={[
              // Corner: a short label; the term.tier glossary sentence is its hover text (4f).
              { id: 'from', header: <span title={t('term.tier')}>{t('ext.savings.matrix.corner')}</span>, cell: (r: { from: Tier }) => t(`enum.tier.${r.from}`), isRowHeader: true },
              ...TIERS.map((to) => ({ id: to, header: t(`enum.tier.${to}`), cell: (r: { from: Tier }) => {
                const c = b.matrix.find((m) => m.from === r.from && m.to === to)
                return c ? t('savings.matrix.cell', { count: c.n, usd: f.usdSigned(c.R) }) : '—'
              } })),
            ]}
            items={TIERS.filter((x) => b.matrix.some((m) => m.from === x)).map((from) => ({ from }))}
          />
        </Container>
        <ChartBox
          title={t('savings.chart.net')}
          chart={<DailyLine data={b.daily.map((d) => ({ day: d.day, v: d.N }))} from={range.from} to={range.to} label={t('savings.chart.net')} title={t('savings.kpi.net')} />}
          columns={[{ id: 'd', header: t('usage.dim.day'), cell: (d: { day: string; N: number }) => f.day(d.day) }, { id: 'n', header: t('savings.col.net'), cell: (d) => f.usdSigned(d.N) }]}
          rows={b.daily}
        />
      </ColumnLayout>
      <Table
        header={<Header variant="h2" actions={<SpaceBetween direction="horizontal" size="xs">
          <ChoiceFilter label={t('common.groupBy')} value={groupBy} onChange={setGroupBy} options={(admin ? (['model', 'dialect', 'caller'] as Group[]) : (['model', 'dialect'] as Group[])).map((g) => ({ value: g, label: t(g === 'model' ? 'usage.dim.model' : g === 'dialect' ? 'usage.dim.dialect' : 'usage.dim.caller') }))} />
          <Button iconName="download" onClick={() => exportCsv(rep, b, projected)}>{t('common.exportCsv')}</Button>
        </SpaceBetween>}>{t('savings.title')}</Header>}
        ariaLabels={{ tableLabel: t('savings.title') }}
        columnDefinitions={[
          { id: 'k', header: t(groupBy === 'model' ? 'usage.dim.model' : groupBy === 'dialect' ? 'usage.dim.dialect' : 'usage.dim.caller'), cell: (r: SavingsRow) => (groupBy === 'caller' && r.key !== 'none' ? <Pii kind="caller">{keyLabel(r.key, rep)}</Pii> : keyLabel(r.key, rep)), isRowHeader: true },
          { id: 'n', header: t('usage.col.requests'), cell: (r) => f.int(r.requests) },
          { id: 'A', header: 'A', cell: (r) => f.usd(r.A) },
          { id: 'B', header: 'B', cell: (r) => f.usd(r.B) },
          { id: 'R', header: 'R', cell: (r) => f.usdSigned(r.R) },
          { id: 'S', header: 'S', cell: (r) => f.usd(r.S) },
          { id: 'X', header: 'X', cell: (r) => f.usd(r.X) },
          { id: 'N', header: t('savings.col.net'), cell: (r) => <Box color={r.N < 0 ? 'text-status-error' : 'inherit'}>{f.usdSigned(r.N)}</Box> },
          { id: 'pct', header: t('savings.col.netPercent'), cell: (r) => (r.rate === undefined ? '—' : f.percent(r.rate)) },
        ]}
        items={b.rows}
      />
    </SpaceBetween>
  )

  const exportCsv = (rep: SavingsReport, b: SavingsBlock, projected: boolean) => {
    const meta = [
      t('usage.export.header', { time: new Date().toISOString(), region: rep.catalog.region, catalogVersion: rep.catalog.version, filters: `${range.from} ${range.to} ${dialect.join(' ')}`.trim() }),
      `baseline=${rep.baseline} view=${projected ? 'projected' : 'actual'} mode=${rep.mode}`,
      'N = B - A - X = R - S - X; R = B - A*; S = A - A*',
      `promptCacheSaving=${rep.promptCacheSaving} otherColdCost=${rep.otherColdCost} cappedRequests=${rep.capped.requests} unmetered=${rep.unmetered.count}`,
    ]
    download(`savings-${rep.baseline}-${range.from}-${range.to}.csv`, toCsv(meta, [groupBy, 'requests', 'A', 'B', 'R', 'S', 'X', 'N', 'rate'], [...b.rows.map((r) => [r.key, r.requests, r.A, r.B, r.R, r.S, r.X, r.N, r.rate]), ['total', b.kpis.requests, b.kpis.A, b.kpis.B, b.kpis.R, b.kpis.S, b.kpis.X, b.kpis.N, b.kpis.rate]]))
  }

  return (
    <ContentLayout header={<Header variant="h1" description={t('savings.description')} actions={<RangeControl range={range} onChange={setRange} />}>{t('savings.title')}</Header>}>
      <SpaceBetween size="l">
        <SpaceBetween direction="horizontal" size="xs">
          <ChoiceFilter label={t('savings.baseline')} value={baseline} onChange={setBaseline} options={BASELINES.map((b) => ({ value: b, label: t(BASE_LABEL[b]) }))} />
          <ListFilter label={t('usage.filter.dialect')} value={dialect} onChange={setDialect} options={DIALECTS.map((x) => ({ value: x, label: t(`enum.dialect.${x}`) }))} />
        </SpaceBetween>
        <Box variant="small" color="text-body-secondary">{t('savings.baseline.help')} {baseline === 'static' ? t('savings.baseline.static.help') : baseline === 'observe-default' ? t('savings.baseline.observeDefault.help') : ''}</Box>
        <QueryView q={q} empty={(rep) => rep.kpis.requests === 0 && rep.capped.requests === 0 && <Empty title={t('state.empty.range')} />}>
          {(rep) => (
            <SpaceBetween size="l">
              {/* Mandatory captions: always visible, never in a tooltip (4f §4.3). */}
              <Captions items={[
                t('savings.caption.listPrice', { catalogVersion: rep.catalog.version }),
                t('savings.caption.sameUsage'),
                t('savings.caption.quality'),
                // The link follows the numbers it backs (4f review).
                <span key="e">{t('savings.caption.evidence')} {evidence ? <Link external href={evidence}>{t('savings.caption.evidenceLink')}</Link> : <Box variant="code">{HARBOR_SUMMARY_PATH}</Box>}</span>,
                rep.mode === 'observe' && t('savings.caption.observe'),
                rep.unmetered.count > 0 && t('savings.caption.unmetered', { count: rep.unmetered.count }),
              ]} />
              {rep.mode === 'observe' && baseline === 'observe-default' && <Box color="text-status-info">{t('savings.empty.observeBaseline')}</Box>}
              <Tabs
                activeTabId={tab}
                onChange={(e) => setSp((cur) => { const n = new URLSearchParams(cur); if (e.detail.activeTabId === 'projected') n.set('tab', 'projected'); else n.delete('tab'); return n }, { replace: true })}
                tabs={[
                  { id: 'actual', label: t('savings.tab.actual'), content: blockView(rep, rep, false) },
                  ...(rep.projected ? [{
                    id: 'projected', label: t('savings.tab.projected'),
                    content: <SpaceBetween size="m">
                      <Captions items={[t('savings.caption.projection'), t('savings.projected.count', { count: rep.projected.differing })]} />
                      {blockView(rep.projected, rep, true)}
                    </SpaceBetween>,
                  }] : []),
                ]}
              />
              <ColumnLayout columns={2}>
                <Container header={<Header variant="h2" description={t('savings.otherCold.help')}>{t('savings.otherCold')}</Header>}><Box variant="awsui-value-large">{f.usd(rep.otherColdCost)}</Box></Container>
                <Container header={<Header variant="h2" description={t('savings.capRow.help')}>{t('savings.capRow')}</Header>}>
                  <Box>{t('common.requests', { count: rep.capped.requests })} · A {f.usd(rep.capped.A)} · B {f.usd(rep.capped.B)}</Box>
                </Container>
              </ColumnLayout>
              <ExpandableSection headerText={t('savings.method')} variant="container">
                <SpaceBetween size="xs">
                  <Box variant="code">{t('savings.kpi.netFormula')}</Box>
                  <Box>{t('savings.kpi.routing.help')}</Box>
                  <Box>{t('savings.kpi.switchPenalty.help')}</Box>
                  <Box>{t('savings.kpi.assessor.help')}</Box>
                  <Box>{t('savings.kpi.cache.help')}</Box>
                  <Box>{t('savings.baseline.static.help')}</Box>
                </SpaceBetween>
              </ExpandableSection>
              <PageFooter region={rep.catalog.region} catalogVersion={rep.catalog.version} />
            </SpaceBetween>
          )}
        </QueryView>
      </SpaceBetween>
    </ContentLayout>
  )
}
