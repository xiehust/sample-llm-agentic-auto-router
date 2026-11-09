// Usage & cost (4f §4.2): real token usage per model and its list price.

import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import ColumnLayout from '@cloudscape-design/components/column-layout'
import ContentLayout from '@cloudscape-design/components/content-layout'
import Header from '@cloudscape-design/components/header'
import Popover from '@cloudscape-design/components/popover'
import SpaceBetween from '@cloudscape-design/components/space-between'
import Table, { type TableProps } from '@cloudscape-design/components/table'
import type { CacheTtl, Dialect, StatusClass, Tier, UsageDimension, UsageReport, UsageRow } from '@auto-router/console-contract'
import { toQuery } from '@auto-router/console-contract'
import { useNavigate, useSearchParams } from 'react-router'
import { useUsage } from '../api/hooks.ts'
import { Captions, ChartBox, PageFooter } from '../components/blocks.tsx'
import { StackedDaily } from '../components/charts.tsx'
import { download, toCsv } from '../components/csv.ts'
import { ChoiceFilter, clearAll, ListFilter, useListParam, useParam } from '../components/filters.tsx'
import { RangeControl, useRange } from '../components/range.tsx'
import { Empty, EmptyFiltered, QueryView } from '../components/states.tsx'
import { Caller, Pct, Tokens, unattributedLabel, Usd } from '../components/values.tsx'
import { useI18n } from '../i18n/I18n.tsx'
import type { MessageKey } from '../i18n/messages.ts'
import { shortModel, useBase } from './scope.ts'

const TIERS: Tier[] = ['fast', 'standard', 'frontier']
const DIALECTS: Dialect[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const STATUS: StatusClass[] = ['2xx', '4xx', '5xx', '499']
const TTLS: CacheTtl[] = ['5m', '30m', '1h', '12h']
const DIM_LABEL: Record<UsageDimension, MessageKey> = { caller: 'usage.dim.caller', model: 'usage.dim.model', tier: 'usage.dim.tier', dialect: 'usage.dim.dialect', day: 'usage.dim.day' }

const writes = (r: UsageRow) => Object.values(r.tokens.cacheWrite).reduce((a, b) => a + (b ?? 0), 0)

export default function Usage() {
  const { t, f, locale } = useI18n()
  const { base, admin } = useBase()
  const nav = useNavigate()
  const [sp, setSp] = useSearchParams()
  const [range, setRange] = useRange()
  const dims: UsageDimension[] = admin ? ['model', 'tier', 'dialect', 'day', 'caller'] : ['model', 'tier', 'dialect', 'day']
  const [groupBy, setGroupBy] = useParam<UsageDimension>('groupBy', dims, 'model')
  const [stackBy, setStackBy] = useParam<Exclude<UsageDimension, 'day'>>('stackBy', dims.filter((d) => d !== 'day') as Exclude<UsageDimension, 'day'>[], 'model')
  const [caller, setCaller] = useListParam('caller')
  const [model, setModel] = useListParam('model')
  const [tier, setTier] = useListParam('tier')
  const [dialect, setDialect] = useListParam('dialect')
  const [status, setStatus] = useListParam('status')
  const filtered = caller.length + model.length + tier.length + dialect.length + status.length > 0
  const q = useUsage(base, {
    from: range.from, to: range.to, groupBy, stackBy,
    ...(admin && caller.length ? { caller } : {}), ...(model.length ? { model } : {}), ...(tier.length ? { tier: tier as Tier[] } : {}),
    ...(dialect.length ? { dialect: dialect as Dialect[] } : {}), ...(status.length ? { status: status as StatusClass[] } : {}),
  })
  // Unfiltered lists for the filter options.
  const optModels = useUsage(base, { from: range.from, to: range.to, groupBy: 'model' })
  const optCallers = useUsage('admin', admin ? { from: range.from, to: range.to, groupBy: 'caller' } : undefined)

  const keyLabel = (d: UsageDimension, k: string, rep?: UsageReport): string => {
    if (d === 'model') return shortModel(k)
    if (d === 'tier') return TIERS.includes(k as Tier) ? t(`enum.tier.${k as Tier}`) : k
    if (d === 'dialect') return DIALECTS.includes(k as Dialect) ? t(`enum.dialect.${k as Dialect}`) : k
    if (d === 'day') return f.day(k)
    const c = rep?.callers?.find((x) => x.key === k)
    return k === 'none' ? unattributedLabel(locale) : c?.name ?? k
  }

  const columns = (rep: UsageReport): TableProps.ColumnDefinition<UsageRow>[] => {
    const ttls = TTLS.filter((ttl) => (rep.totals.tokens.cacheWrite[ttl] ?? 0) > 0)
    return [
      { id: 'key', header: t(DIM_LABEL[groupBy]), cell: (r) => (r.key === 'total' ? <Box variant="strong">{t('common.total')}</Box> : groupBy === 'caller' ? <Caller c={rep.callers?.find((c) => c.key === r.key)} /> : keyLabel(groupBy, r.key, rep)), isRowHeader: true },
      { id: 'requests', header: t('usage.col.requests'), cell: (r) => f.int(r.requests) },
      { id: 'uncached', header: t('token.uncachedInput'), cell: (r) => <Tokens v={r.tokens.uncached} /> },
      { id: 'read', header: t('token.cacheRead'), cell: (r) => <Tokens v={r.tokens.cacheRead} /> },
      ...ttls.map((ttl) => ({ id: `w${ttl}`, header: t('token.cacheWrite', { ttl }), cell: (r: UsageRow) => <Tokens v={r.tokens.cacheWrite[ttl] ?? 0} /> })),
      { id: 'output', header: t('token.output'), cell: (r) => <span><Tokens v={r.tokens.output} />{r.tokens.reasoning > 0 && <Box variant="small" color="text-body-secondary">{t('token.reasoning')} <Tokens v={r.tokens.reasoning} /></Box>}</span> },
      { id: 'costByClass', header: t('usage.col.costByClass'), cell: (r) => <Box variant="small">{f.usd(r.cost.input)} · {f.usd(r.cost.cacheRead)} · {f.usd(r.cost.cacheWrite)} · {f.usd(r.cost.output)}</Box> },
      { id: 'cost', header: t('usage.col.cost'), cell: (r) => <Box variant="strong"><Usd v={r.cost.total} />{r.longContextRequests > 0 && <span title={t('usage.longContext')}> ⚑</span>}</Box> },
      { id: 'hit', header: t('usage.col.hitRate'), cell: (r) => <Pct v={r.hitRate} /> },
      { id: 'errors', header: t('usage.col.errors'), cell: (r) => f.int(r.errors) },
      { id: 'unmetered', header: t('usage.col.unmetered'), cell: (r) => f.int(r.unmetered.count) },
      { id: 'bound', header: t('usage.col.unmeteredBound'), cell: (r) => (r.unmetered.count ? <span>{f.usd(r.unmetered.upperBoundUsd)}{r.unmetered.partial && <Box variant="small" color="text-status-warning">{t('caption.unmetered.partial')}</Box>}</span> : '—') },
    ]
  }

  const exportCsv = (rep: UsageReport) => {
    const filters = [range.from, range.to, ...model, ...tier, ...dialect, ...status, ...caller].join(' ')
    const ttls = TTLS.filter((ttl) => (rep.totals.tokens.cacheWrite[ttl] ?? 0) > 0)
    const header = [groupBy, 'requests', 'uncachedInputTokens', 'cacheReadTokens', ...ttls.map((x) => `cacheWrite${x}Tokens`), 'outputTokens', 'reasoningTokens', 'costInputUsd', 'costCacheReadUsd', 'costCacheWriteUsd', 'costOutputUsd', 'costTotalUsd', 'hitRate', 'errors', 'unmeteredCalls', 'unmeteredUpperBoundUsd', 'unmeteredPartial']
    const rows = [...rep.rows, rep.totals].map((r) => [r.key, r.requests, r.tokens.uncached, r.tokens.cacheRead, ...ttls.map((x) => r.tokens.cacheWrite[x] ?? 0), r.tokens.output, r.tokens.reasoning, r.cost.input, r.cost.cacheRead, r.cost.cacheWrite, r.cost.output, r.cost.total, r.hitRate, r.errors, r.unmetered.count, r.unmetered.upperBoundUsd, r.unmetered.partial])
    download(`usage-${range.from}-${range.to}.csv`, toCsv([t('usage.export.header', { time: new Date().toISOString(), region: rep.catalog.region, catalogVersion: rep.catalog.version, filters: filters || '—' })], header, rows))
  }

  const drill = () => nav(`/decisions${toQuery({ range: sp.get('range') ?? undefined, from: sp.get('from') ?? undefined, to: sp.get('to') ?? undefined, model, tier, dialect, status, caller: admin ? caller : [] })}`)

  return (
    <ContentLayout header={<Header variant="h1" description={t('usage.description')} actions={<RangeControl range={range} onChange={setRange} />}>{t('usage.title')}</Header>}>
      <SpaceBetween size="l">
        <SpaceBetween direction="horizontal" size="xs">
          {admin && <span data-pii="caller-filter"><ListFilter label={t('usage.filter.caller')} value={caller} onChange={setCaller} options={(optCallers.data?.rows ?? []).map((r) => ({ value: r.key, label: keyLabel('caller', r.key, optCallers.data) }))} /></span>}
          <ListFilter label={t('usage.filter.model')} value={model} onChange={setModel} options={(optModels.data?.rows ?? []).map((r) => ({ value: r.key, label: shortModel(r.key) }))} />
          <ListFilter label={t('usage.filter.tier')} value={tier} onChange={setTier} options={TIERS.map((x) => ({ value: x, label: t(`enum.tier.${x}`) }))} />
          <ListFilter label={t('usage.filter.dialect')} value={dialect} onChange={setDialect} options={DIALECTS.map((x) => ({ value: x, label: t(`enum.dialect.${x}`) }))} />
          <ListFilter label={t('usage.filter.status')} value={status} onChange={setStatus} options={STATUS.map((x) => ({ value: x, label: t(`enum.statusClass.${x}`) }))} />
          {filtered && <Button onClick={() => clearAll(setSp)}>{t('common.clearFilters')}</Button>}
        </SpaceBetween>
        <QueryView q={q} empty={(rep) => rep.totals.requests === 0 && (filtered ? <EmptyFiltered onClear={() => clearAll(setSp)} /> : <Empty title={t('state.empty.range')} />)}>
          {(rep) => (
            <SpaceBetween size="l">
              <ColumnLayout columns={2}>
                {/* Stacked by caller, the legend names callers: masked in the docs screenshots (data-pii). */}
                <div data-pii={stackBy === 'caller' ? 'caller-series' : undefined}>
                <ChartBox
                  title={t('usage.chart.cost')}
                  chart={<SpaceBetween size="s">
                    <ChoiceFilter label={t('usage.stackBy')} value={stackBy} onChange={setStackBy} options={dims.filter((d) => d !== 'day').map((d) => ({ value: d as Exclude<UsageDimension, 'day'>, label: t(DIM_LABEL[d]) }))} />
                    <StackedDaily points={rep.daily} from={range.from} to={range.to} metric="cost" label={t('usage.chart.cost')} seriesLabel={(k) => keyLabel(stackBy, k, rep)} />
                  </SpaceBetween>}
                  columns={[{ id: 'day', header: t('usage.dim.day'), cell: (p: { day: string; series: string; costUsd: number }) => f.day(p.day) }, { id: 's', header: t(DIM_LABEL[stackBy]), cell: (p) => keyLabel(stackBy, p.series, rep) }, { id: 'c', header: t('usage.col.cost'), cell: (p) => f.usd(p.costUsd) }]}
                  rows={rep.daily}
                />
                </div>
                <ChartBox
                  title={t('usage.chart.tokens')}
                  chart={<StackedDaily metric="tokens" from={range.from} to={range.to} label={t('usage.chart.tokens')} points={byClass(rep, t)} />}
                  columns={[{ id: 'day', header: t('usage.dim.day'), cell: (p: { day: string; series: string; costUsd: number; tokens: UsageRow['tokens'] }) => f.day(p.day) }, { id: 's', header: t('token.total'), cell: (p) => p.series }, { id: 'v', header: t('token.total'), cell: (p) => f.compact(p.tokens.uncached + p.tokens.cacheRead + p.tokens.output + Object.values(p.tokens.cacheWrite).reduce((a, b) => a + (b ?? 0), 0)) }]}
                  rows={byClass(rep, t)}
                />
              </ColumnLayout>
              <Table
                header={<Header variant="h2" counter={`(${rep.rows.length})`} actions={
                  <SpaceBetween direction="horizontal" size="xs">
                    <ChoiceFilter label={t('common.groupBy')} value={groupBy} onChange={setGroupBy} options={dims.map((d) => ({ value: d, label: t(DIM_LABEL[d]) }))} />
                    <Button onClick={drill}>{t('usage.drill')}</Button>
                    <Button iconName="download" onClick={() => exportCsv(rep)}>{t('common.exportCsv')}</Button>
                  </SpaceBetween>
                }>{t('usage.title')}</Header>}
                columnDefinitions={columns(rep)}
                items={[...rep.rows, rep.totals]}
                wrapLines={false}
                stickyColumns={{ first: 1 }}
                resizableColumns
                ariaLabels={{ tableLabel: t('usage.title') }}
              />
              <Captions items={[
                t('caption.listPrice', { region: rep.catalog.region, catalogVersion: rep.catalog.version }),
                t('caption.scope'),
                rep.totals.unmetered.count > 0 && (
                  <span>{t('caption.unmetered', { count: rep.totals.unmetered.count, upperBound: f.usd(rep.totals.unmetered.upperBoundUsd) })}{' '}
                    <Popover triggerType="text" content={t('caption.unmetered.help')}>{t('common.learnMore')}</Popover>
                    {rep.totals.unmetered.partial && <> · <Popover triggerType="text" content={t('caption.unmetered.partial.help')}>{t('caption.unmetered.partial')}</Popover></>}
                  </span>
                ),
                t('caption.utcDays'),
              ]} />
              <PageFooter region={rep.catalog.region} catalogVersion={rep.catalog.version} dataAsOf={rep.dataAsOf} />
            </SpaceBetween>
          )}
        </QueryView>
      </SpaceBetween>
    </ContentLayout>
  )
}

/** Daily tokens re-keyed by token class, for the tokens chart. */
function byClass(rep: UsageReport, t: ReturnType<typeof useI18n>['t']) {
  const out = new Map<string, { day: string; series: string; costUsd: number; tokens: UsageRow['tokens'] }>()
  const add = (day: string, series: string, v: number) => {
    const k = `${day}|${series}`
    const p = out.get(k) ?? { day, series, costUsd: 0, tokens: { uncached: 0, cacheRead: 0, cacheWrite: {}, output: 0, reasoning: 0 } }
    p.tokens.uncached += v
    out.set(k, p)
  }
  for (const p of rep.daily) {
    add(p.day, t('token.uncachedInput'), p.tokens.uncached)
    add(p.day, t('token.cacheRead'), p.tokens.cacheRead)
    add(p.day, t('token.cacheWriteTotal'), Object.values(p.tokens.cacheWrite).reduce((a, b) => a + (b ?? 0), 0))
    add(p.day, t('token.output'), p.tokens.output)
  }
  return [...out.values()]
}

export { writes }
