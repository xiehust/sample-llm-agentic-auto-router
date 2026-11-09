// Decisions (4f §4.4): each routing decision and its basis. Records are kept `retentionDays`; daily totals longer.

import Button from '@cloudscape-design/components/button'
import ContentLayout from '@cloudscape-design/components/content-layout'
import Header from '@cloudscape-design/components/header'
import Input from '@cloudscape-design/components/input'
import SpaceBetween from '@cloudscape-design/components/space-between'
import Table from '@cloudscape-design/components/table'
import Toggle from '@cloudscape-design/components/toggle'
import type { DecisionAction, DecisionPoint, Dialect, MissReason, RecordQuery, RecordSummary, StatusClass, Tier } from '@auto-router/console-contract'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { useProfile, useRecords, useUsage } from '../api/hooks.ts'
import { Captions } from '../components/blocks.tsx'
import { download, toCsv } from '../components/csv.ts'
import { ChoiceFilter, clearAll, ListFilter, useBoolParam, useListParam, useParam } from '../components/filters.tsx'
import { RangeControl, useRange } from '../components/range.tsx'
import { Empty, EmptyFiltered, QueryView } from '../components/states.tsx'
import { unattributedLabel } from '../components/values.tsx'
import { useI18n } from '../i18n/I18n.tsx'
import { useRecordColumns } from './decisions-common.tsx'
import { shortModel, useBase } from './scope.ts'

const ACTIONS: DecisionAction[] = ['initialize', 'retain', 'switch', 'pin']
const POINTS: DecisionPoint[] = ['pinned', 'hard-lock-tool-loop', 'hard-lock-response-chain', 'hard-lock-state', 'session-start', 'subagent-start', 'idle-expired', 'compaction', 'user-turn', 'failover', 'task-start', 'prefix-reset']
const DIALECTS: Dialect[] = ['anthropic-messages', 'openai-chat', 'openai-responses']
const TIERS: Tier[] = ['fast', 'standard', 'frontier']
const STATUS: StatusClass[] = ['2xx', '4xx', '5xx', '499']
const MISS: Array<MissReason | 'any' | ''> = ['', 'any', 'model_changed', 'ttl_expired', 'prefix_changed', 'unknown']

export default function Decisions() {
  const { t, locale } = useI18n()
  const { base, admin } = useBase()
  const profile = useProfile()
  const [sp, setSp] = useSearchParams()
  const [range, setRange] = useRange()
  const [caller, setCaller] = useListParam('caller')
  const [dialect, setDialect] = useListParam('dialect')
  const [action, setAction] = useListParam('action')
  const [point, setPoint] = useListParam('point')
  const [model, setModel] = useListParam('model')
  const [tier, setTier] = useListParam('tier')
  const [status, setStatus] = useListParam('status')
  const [mode, setMode] = useParam<'' | 'observe' | 'auto'>('mode', ['', 'observe', 'auto'], '')
  const [miss, setMiss] = useParam<MissReason | 'any' | ''>('miss', MISS, '')
  const [assessor, setAssessor] = useBoolParam('assessor')
  const [failover, setFailover] = useBoolParam('failover')
  const [differs, setDiffers] = useBoolParam('wouldChooseDiffers')
  const [session, setSession] = useState(sp.get('session') ?? '')
  const cursor = sp.get('cursor') ?? undefined
  const [pages, setPages] = useState<RecordSummary[]>([])

  const q: RecordQuery = {
    from: range.fromIso, to: range.toIso, limit: 50,
    ...(admin && caller.length ? { caller } : {}), ...(sp.get('session') ? { session: sp.get('session') as string } : {}),
    ...(dialect.length ? { dialect: dialect as Dialect[] } : {}), ...(action.length ? { action: action as DecisionAction[] } : {}),
    ...(point.length ? { point: point as DecisionPoint[] } : {}), ...(model.length ? { model } : {}), ...(tier.length ? { tier: tier as Tier[] } : {}),
    ...(status.length ? { status: status as StatusClass[] } : {}), ...(mode ? { mode } : {}), ...(miss ? { miss } : {}),
    ...(assessor !== undefined ? { assessor } : {}), ...(failover !== undefined ? { failover } : {}), ...(differs !== undefined ? { wouldChooseDiffers: differs } : {}),
    ...(cursor ? { cursor } : {}),
  }
  const recs = useRecords(base, q)
  const key = JSON.stringify({ ...q, cursor: undefined })
  // "Load more" appends pages; any filter change starts over.
  useEffect(() => { setPages([]) }, [key])
  useEffect(() => {
    if (!recs.data) return
    setPages((cur) => (cursor ? [...cur.filter((x) => !recs.data!.items.some((y) => y.reqId === x.reqId)), ...recs.data!.items] : recs.data!.items))
  }, [recs.data, cursor])
  const optModels = useUsage(base, { from: range.from, to: range.to, groupBy: 'model' })
  const optCallers = useUsage('admin', admin ? { from: range.from, to: range.to, groupBy: 'caller' } : undefined)
  const columns = useRecordColumns(admin)
  const filtered = [caller, dialect, action, point, model, tier, status].some((x) => x.length > 0) || !!mode || !!miss || assessor !== undefined || failover !== undefined || differs !== undefined || !!sp.get('session')

  const exportCsv = () => {
    const header = ['ts', 'reqId', ...(admin ? ['caller'] : []), 'session', 'dialect', 'requested', 'action', 'point', 'mode', 'servedModel', 'tier', 'wouldChoose', 'promptTokens', 'outputTokens', 'costUsd', 'hitRate', 'status', 'errorCode', 'failover', 'miss', 'assessor']
    const rows = pages.map((r) => [r.ts, r.reqId, ...(admin ? [r.caller?.key ?? 'none'] : []), r.session, r.dialect, r.requested, r.action, r.point, r.mode, r.servedModel, r.tier, r.wouldChoose, r.promptTokens, r.outputTokens, r.costUsd, r.hitRate, r.status, r.errorCode, r.flags.failover ?? false, r.flags.miss, r.flags.assessor])
    download(`decisions-${range.from}-${range.to}.csv`, toCsv([`${range.fromIso} .. ${range.toIso}`], header, rows))
  }

  const setSessionParam = (v: string) => setSp((cur) => { const n = new URLSearchParams(cur); if (v.trim()) n.set('session', v.trim()); else n.delete('session'); n.delete('cursor'); return n }, { replace: true })

  return (
    <ContentLayout header={<Header variant="h1" description={t('decisions.description')} actions={<RangeControl range={range} onChange={setRange} />}>{t('decisions.title')}</Header>}>
      <SpaceBetween size="l">
        <SpaceBetween direction="horizontal" size="xs">
          {admin && <span data-pii="caller-filter"><ListFilter label={t('usage.filter.caller')} value={caller} onChange={setCaller} options={(optCallers.data?.rows ?? []).map((r) => ({ value: r.key, label: r.key === 'none' ? unattributedLabel(locale) : optCallers.data?.callers?.find((c) => c.key === r.key)?.name ?? r.key }))} /></span>}
          <Input type="search" placeholder={t('decisions.filter.session')} ariaLabel={t('decisions.filter.session')} value={session} onChange={(e) => setSession(e.detail.value)} onKeyDown={(e) => { if (e.detail.key === 'Enter') setSessionParam(session) }} onBlur={() => setSessionParam(session)} />
          <ListFilter label={t('usage.filter.dialect')} value={dialect} onChange={setDialect} options={DIALECTS.map((x) => ({ value: x, label: t(`enum.dialect.${x}`) }))} />
          <ListFilter label={t('decisions.filter.action')} value={action} onChange={setAction} options={ACTIONS.map((x) => ({ value: x, label: t(`enum.action.${x}`) }))} />
          <ListFilter label={t('decisions.filter.point')} value={point} onChange={setPoint} options={POINTS.map((x) => ({ value: x, label: t(`enum.point.${x}`) }))} />
          <ListFilter label={t('usage.filter.model')} value={model} onChange={setModel} options={(optModels.data?.rows ?? []).map((r) => ({ value: r.key, label: shortModel(r.key) }))} />
          <ListFilter label={t('usage.filter.tier')} value={tier} onChange={setTier} options={TIERS.map((x) => ({ value: x, label: t(`enum.tier.${x}`) }))} />
          <ListFilter label={t('usage.filter.status')} value={status} onChange={setStatus} options={STATUS.map((x) => ({ value: x, label: t(`enum.statusClass.${x}`) }))} />
          <ChoiceFilter label={t('decisions.filter.mode')} value={mode} onChange={setMode} options={[{ value: '', label: t('common.all') }, { value: 'observe', label: t('enum.mode.observe') }, { value: 'auto', label: t('enum.mode.auto') }]} />
          <ChoiceFilter label={t('decisions.filter.miss')} value={miss} onChange={setMiss} options={MISS.map((m) => ({ value: m, label: m === '' ? t('common.all') : m === 'any' ? t('decisions.icon.miss') : t(`enum.missReason.${m}`) }))} />
          <Toggle checked={assessor === true} onChange={(e) => setAssessor(e.detail.checked ? true : undefined)}>{t('decisions.filter.assessor')}</Toggle>
          <Toggle checked={failover === true} onChange={(e) => setFailover(e.detail.checked ? true : undefined)}>{t('decisions.filter.failover')}</Toggle>
          {profile.data?.deployment.mode === 'observe' && <Toggle checked={differs === true} onChange={(e) => setDiffers(e.detail.checked ? true : undefined)}>{t('decisions.filter.wouldDiffer')}</Toggle>}
          {filtered && <Button onClick={() => { setSession(''); clearAll(setSp) }}>{t('common.clearFilters')}</Button>}
        </SpaceBetween>
        <QueryView q={recs} empty={(d) => d.items.length === 0 && !cursor && (filtered ? <EmptyFiltered onClear={() => clearAll(setSp)} /> : <Empty title={t('decisions.empty')} />)}>
          {(d) => (
            <Table
              header={<Header variant="h2" counter={`(${pages.length}${d.nextCursor ? '+' : ''})`} actions={<Button iconName="download" onClick={exportCsv}>{t('common.exportCsv')}</Button>}>{t('decisions.title')}</Header>}
              columnDefinitions={columns}
              items={pages}
              loading={recs.isFetching && !!cursor}
              wrapLines={false}
              resizableColumns
              stickyColumns={{ first: 1 }}
              ariaLabels={{ tableLabel: t('decisions.title') }}
              footer={d.nextCursor ? <Button onClick={() => setSp((cur) => { const n = new URLSearchParams(cur); n.set('cursor', d.nextCursor as string); return n }, { replace: true })}>{t('common.showMore')}</Button> : undefined}
            />
          )}
        </QueryView>
        <Captions items={[t('caption.retention', { days: profile.data?.deployment.retentionDays ?? 90, rollupDays: profile.data?.deployment.rollupDays ?? 400 }), t('caption.noContent')]} />
      </SpaceBetween>
    </ContentLayout>
  )
}
