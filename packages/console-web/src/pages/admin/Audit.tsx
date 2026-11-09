// Audit log (4f §4.12): who changed what, and when. Read-only; CSV export.

import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import ColumnLayout from '@cloudscape-design/components/column-layout'
import ContentLayout from '@cloudscape-design/components/content-layout'
import ExpandableSection from '@cloudscape-design/components/expandable-section'
import Header from '@cloudscape-design/components/header'
import Input from '@cloudscape-design/components/input'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import Table from '@cloudscape-design/components/table'
import type { AuditAction, AuditEntry } from '@auto-router/console-contract'
import { useState } from 'react'
import { useAudit } from '../../api/hooks.ts'
import { download, toCsv } from '../../components/csv.ts'
import { ListFilter, useListParam } from '../../components/filters.tsx'
import { RangeControl, useRange } from '../../components/range.tsx'
import { Empty, QueryView } from '../../components/states.tsx'
import { Mono, Time } from '../../components/values.tsx'
import { useI18n } from '../../i18n/I18n.tsx'

const ACTIONS: AuditAction[] = ['member.invite', 'member.role', 'member.update', 'member.disable', 'member.enable', 'member.signOut', 'member.delete', 'client.create', 'client.update', 'client.rotate', 'client.disable', 'client.enable', 'client.delete', 'config.draft', 'config.discard', 'config.activate', 'config.rollback', 'config.rejected', 'config.redeliver', 'settings.change', 'gateway.edit']

export default function Audit() {
  const { t } = useI18n()
  const [range, setRange] = useRange('30d')
  const [action, setAction] = useListParam('action')
  const [actor, setActor] = useState('')
  const [target, setTarget] = useState('')
  const q = useAudit({ from: range.from, to: range.to, limit: 200, ...(action.length ? { action: action as AuditAction[] } : {}), ...(actor ? { actor } : {}), ...(target ? { target } : {}) })
  const actorName = (e: AuditEntry) => (e.actor.kind === 'router' ? t('audit.actor.router') : e.actor.name ?? e.actor.key ?? '—')
  const exportCsv = (items: AuditEntry[]) => download(`audit-${range.from}-${range.to}.csv`, toCsv([`${range.from} .. ${range.to}`], ['ts', 'actor', 'action', 'target', 'summary', 'result', 'errorCode', 'requestId'],
    items.map((e) => [e.ts, actorName(e), e.action, e.target, e.summary, e.result, e.errorCode, e.requestId])))
  return (
    <ContentLayout header={<Header variant="h1" description={t('audit.description')} actions={<RangeControl range={range} onChange={setRange} />}>{t('audit.title')}</Header>}>
      <SpaceBetween size="l">
        <SpaceBetween direction="horizontal" size="xs">
          <Input type="search" placeholder={t('audit.filter.actor')} ariaLabel={t('audit.filter.actor')} value={actor} onChange={(e) => setActor(e.detail.value)} />
          <ListFilter label={t('audit.filter.action')} value={action} onChange={setAction} options={ACTIONS.map((a) => ({ value: a, label: t(`audit.action.${a}`) }))} />
          <Input type="search" placeholder={t('audit.filter.target')} ariaLabel={t('audit.filter.target')} value={target} onChange={(e) => setTarget(e.detail.value)} />
        </SpaceBetween>
        <QueryView q={q} empty={(d) => d.items.length === 0 && <Empty title={t('audit.empty')} />}>
          {(d) => (
            <Table
              header={<Header variant="h2" counter={`(${d.items.length})`} description={t('audit.readOnly')} actions={<Button iconName="download" onClick={() => exportCsv(d.items)}>{t('common.exportCsv')}</Button>}>{t('audit.title')}</Header>}
              items={d.items}
              ariaLabels={{ tableLabel: t('audit.title') }}
              wrapLines
              columnDefinitions={[
                { id: 't', header: t('audit.col.time'), cell: (e) => <Time iso={e.ts} />, isRowHeader: true },
                { id: 'a', header: t('audit.col.actor'), cell: (e) => <span data-pii="actor">{actorName(e)}</span> },
                { id: 'x', header: t('audit.col.action'), cell: (e) => t(`audit.action.${e.action}`) },
                { id: 'g', header: t('audit.col.target'), cell: (e) => <span data-pii="target"><Mono>{e.target}</Mono></span> },
                { id: 'r', header: t('audit.col.result'), cell: (e) => (e.result === 'succeeded' ? <StatusIndicator type="success">{t('audit.result.ok')}</StatusIndicator> : <StatusIndicator type="error">{t('audit.result.failed', { code: e.errorCode ?? '?' })}</StatusIndicator>) },
                { id: 's', header: t('audit.col.summary'), cell: (e) => (
                  <ExpandableSection headerText={<span lang="en" data-pii="audit-summary">{e.summary}</span>} variant="footer">
                    <SpaceBetween size="xs">
                      <Box variant="small"><Mono>{e.requestId}</Mono></Box>
                      {(e.before !== undefined || e.after !== undefined) && (
                        <ColumnLayout columns={2}>
                          <div><Box variant="awsui-key-label">{t('audit.before')}</Box><pre className="llmar-diff">{JSON.stringify(e.before ?? null, null, 2)}</pre></div>
                          <div><Box variant="awsui-key-label">{t('audit.after')}</Box><pre className="llmar-diff">{JSON.stringify(e.after ?? null, null, 2)}</pre></div>
                        </ColumnLayout>
                      )}
                    </SpaceBetween>
                  </ExpandableSection>
                ) },
              ]}
            />
          )}
        </QueryView>
      </SpaceBetween>
    </ContentLayout>
  )
}
