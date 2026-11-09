// Session timeline (4f §4.5): one session's requests in order, one lane per lineage (main agent first), each
// request a point coloured by served tier, with markers for break points, switches, misses, failovers and assessor
// consultations. Points are buttons (keyboard reachable) that open the decision.

import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import ColumnLayout from '@cloudscape-design/components/column-layout'
import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import Header from '@cloudscape-design/components/header'
import SpaceBetween from '@cloudscape-design/components/space-between'
import Table from '@cloudscape-design/components/table'
import Toggle from '@cloudscape-design/components/toggle'
import { colorBackgroundContainerHeader } from '@cloudscape-design/design-tokens'
import type { RecordSummary, SessionDetail } from '@auto-router/console-contract'
import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { ApiError } from '../api/client.ts'
import { useSession } from '../api/hooks.ts'
import { Captions, Kpi } from '../components/blocks.tsx'
import { download, toCsv } from '../components/csv.ts'
import { ChoiceFilter } from '../components/filters.tsx'
import { NotFound, QueryView } from '../components/states.tsx'
import { Caller, Mono, Pct, useTime } from '../components/values.tsx'
import { useI18n } from '../i18n/I18n.tsx'
import { recordHref, useRecordColumns } from './decisions-common.tsx'
import { shortModel, useBase } from './scope.ts'

const BREAK_POINTS = new Set(['session-start', 'subagent-start', 'idle-expired', 'compaction', 'user-turn', 'task-start', 'prefix-reset', 'failover'])

export default function Session() {
  const { session } = useParams()
  const { base, admin } = useBase()
  const [sp] = useSearchParams()
  const caller = sp.get('caller') ?? undefined
  const q = useSession(base, session, admin ? caller : undefined)
  if ((q.error instanceof ApiError && q.error.notFound) || (admin && !caller)) return <NotFound />
  return <QueryView q={q}>{(s) => <Timeline s={s} admin={admin} />}</QueryView>
}

function Timeline({ s, admin }: { s: SessionDetail; admin: boolean }) {
  const { t, f } = useI18n()
  const time = useTime()
  const nav = useNavigate()
  const [lineage, setLineage] = useState('')
  const [breaksOnly, setBreaksOnly] = useState(false)
  const columns = useRecordColumns(admin)
  const shown = s.items.filter((r) => (!lineage || r.lineage === lineage) && (!breaksOnly || (r.point && BREAK_POINTS.has(r.point))))
  const laneName = (l: SessionDetail['lineages'][number], i: number) => (l.kind === 'root' ? t('timeline.lane.root') : t('timeline.lane.subagent', { n: i }))

  const pointLabel = (r: RecordSummary): string => {
    const parts = [time(r.ts), shortModel(r.servedModel)]
    if (r.point && BREAK_POINTS.has(r.point)) parts.push(t('timeline.marker.breakPoint', { point: t(`enum.point.${r.point}`) }))
    if (r.flags.switch) parts.push(t('decisions.col.action') + ': ' + t('enum.action.switch'))
    if (r.flags.miss) parts.push(t('timeline.marker.miss', { reason: t(`enum.missReason.${r.flags.miss}`) }))
    if (r.flags.failover) parts.push(t('timeline.marker.failover'))
    if (r.flags.assessor) parts.push(t('timeline.marker.assessor', { tier: r.flags.assessor }))
    return parts.join(' · ')
  }
  const glyph = (r: RecordSummary) => (r.flags.failover ? '⇄' : r.flags.miss ? '◌' : r.flags.switch ? '↕' : r.flags.assessor ? '◆' : r.point && BREAK_POINTS.has(r.point) ? '|' : '')

  const exportCsv = () => download(`session-${s.session}.csv`, toCsv([`session ${s.session}`], ['ts', 'reqId', 'lineage', 'action', 'point', 'servedModel', 'tier', 'promptTokens', 'outputTokens', 'costUsd', 'hitRate', 'status'],
    s.items.map((r) => [r.ts, r.reqId, r.lineage, r.action, r.point, r.servedModel, r.tier, r.promptTokens, r.outputTokens, r.costUsd, r.hitRate, r.status])))

  return (
    <ContentLayout header={<Header variant="h1" description={t('timeline.firstLast', { first: time(s.first), last: time(s.last) })} actions={<Button iconName="download" onClick={exportCsv}>{t('common.exportCsv')}</Button>}>
      {t('timeline.title', { session: s.session.slice(0, 12) })}
    </Header>}>
      <SpaceBetween size="l">
        {s.live && <Box color="text-status-info">{t('timeline.live', { minutes: 3 })}</Box>}
        <Container>
          <ColumnLayout columns={5} variant="text-grid">
            {admin && <Kpi label={t('decisions.col.caller')} value={<Caller c={s.caller} />} />}
            <Kpi label={t('timeline.kpi.requests')} value={f.int(s.requests)} />
            <Kpi label={t('timeline.kpi.lineages')} value={f.int(s.lineages.length)} />
            <Kpi label={t('timeline.kpi.models')} value={s.models.map(shortModel).join(', ')} />
            <Kpi label={t('timeline.kpi.switches')} value={f.int(s.switches)} />
            <Kpi label={t('timeline.kpi.misses')} value={f.int(s.misses)} />
            <Kpi label={t('timeline.kpi.failovers')} value={f.int(s.failovers)} />
            <Kpi label={t('timeline.kpi.cost')} value={f.usd(s.costUsd)} />
            <Kpi label={t('timeline.kpi.hitRate')} value={<Pct v={s.hitRate} />} />
          </ColumnLayout>
        </Container>
        <SpaceBetween direction="horizontal" size="s">
          <ChoiceFilter label={t('timeline.filter.lineage')} value={lineage} onChange={setLineage} options={[{ value: '', label: t('common.all') }, ...s.lineages.map((l, i) => ({ value: l.lineage, label: laneName(l, i) }))]} />
          <Toggle checked={breaksOnly} onChange={(e) => setBreaksOnly(e.detail.checked)}>{t('timeline.filter.breakPointsOnly')}</Toggle>
        </SpaceBetween>
        <Container header={<Header variant="h2">{t('timeline.title', { session: '' }).trim()}</Header>}>
          <div className="llmar-lanes" style={{ background: colorBackgroundContainerHeader }}>
            {s.lineages.filter((l) => !lineage || l.lineage === lineage).map((l, i) => (
              <div className="llmar-lane" key={l.lineage} role="list" aria-label={laneName(l, i)}>
                <span className="llmar-lane-label">{laneName(l, i)} <Mono>{l.lineage.slice(0, 8)}</Mono></span>
                {shown.filter((r) => r.lineage === l.lineage).map((r) => (
                  <button key={r.reqId} type="button" role="listitem" className={`llmar-dot llmar-tier-${r.tier ?? 'none'}`} title={pointLabel(r)} aria-label={pointLabel(r)}
                    onClick={() => nav(recordHref(r, admin))}>{glyph(r)}</button>
                ))}
              </div>
            ))}
          </div>
          <Box variant="small" color="text-body-secondary" margin={{ top: 's' }}>
            <span className="llmar-dot llmar-tier-fast" aria-hidden /> {t('enum.tier.fast')} · <span className="llmar-dot llmar-tier-standard" aria-hidden /> {t('enum.tier.standard')} · <span className="llmar-dot llmar-tier-frontier" aria-hidden /> {t('enum.tier.frontier')} · | {t('term.breakPoint')} · ↕ {t('enum.action.switch')} · ◌ {t('decisions.icon.miss')} · ⇄ {t('term.failover')} · ◆ {t('term.assessor')}
          </Box>
        </Container>
        <Table
          header={<Header variant="h2" counter={`(${shown.length})`} description={t('timeline.bar.legend')}>{t('decisions.title')}</Header>}
          columnDefinitions={[...columns, { id: 'bar', header: t('timeline.bar.legend'), cell: (r) => (r.bar ? <CacheBar b={r.bar} /> : '—') }]}
          items={shown}
          wrapLines={false}
          resizableColumns
          ariaLabels={{ tableLabel: t('decisions.title') }}
        />
        <Captions items={[t('caption.noContent')]} />
      </SpaceBetween>
    </ContentLayout>
  )
}

function CacheBar({ b }: { b: NonNullable<RecordSummary['bar']> }) {
  const total = b.read + b.write + b.uncached || 1
  const pct = (v: number) => `${(v / total) * 100}%`
  return <span className="llmar-bar" aria-hidden><span className="read" style={{ width: pct(b.read) }} /><span className="write" style={{ width: pct(b.write) }} /><span className="uncached" style={{ width: pct(b.uncached) }} /></span>
}
