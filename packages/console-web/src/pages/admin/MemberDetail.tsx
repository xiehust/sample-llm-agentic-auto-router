import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import ColumnLayout from '@cloudscape-design/components/column-layout'
import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import Header from '@cloudscape-design/components/header'
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs'
import Link from '@cloudscape-design/components/link'
import ProgressBar from '@cloudscape-design/components/progress-bar'
import SpaceBetween from '@cloudscape-design/components/space-between'
import Table from '@cloudscape-design/components/table'
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ApiError } from '../../api/client.ts'
import { useMember } from '../../api/hooks.ts'
import { NotFound, QueryView } from '../../components/states.tsx'
import { Pii, Time } from '../../components/values.tsx'
import { useI18n } from '../../i18n/I18n.tsx'
import { timelineHref } from '../decisions-common.tsx'
import { MemberLimitsModal, MemberStatus } from './Members.tsx'

export default function MemberDetail() {
  const { id } = useParams()
  const { t, f } = useI18n()
  const nav = useNavigate()
  const q = useMember(id)
  const [edit, setEdit] = useState(false)
  if (q.error instanceof ApiError && q.error.notFound) return <NotFound />
  return (
    <QueryView q={q}>{(m) => (
      <ContentLayout header={<Header variant="h1" description={<Pii kind="member-email">{m.email}</Pii>} actions={<SpaceBetween direction="horizontal" size="xs">
        <Button onClick={() => nav(`/usage?groupBy=model&caller=${encodeURIComponent(`user:${m.id}`)}&range=thisMonth`)}>{t('members.detail.usage')}</Button>
        <Button onClick={() => setEdit(true)}>{t('common.edit')}</Button>
      </SpaceBetween>}><Pii kind="member">{m.name ?? m.username}</Pii></Header>}>
        <SpaceBetween size="l">
          <Container>
            <KeyValuePairs columns={4} items={[
              { label: t('members.col.role'), value: t(`app.role.${m.role}`) },
              { label: t('members.col.status'), value: <MemberStatus m={m} /> },
              { label: t('members.col.created'), value: <Time iso={m.createdAt} /> },
              { label: t('members.col.lastRequest'), value: <Time iso={m.lastRequestAt} /> },
              { label: t('members.col.costMonth'), value: f.usd(m.costThisMonthUsd) },
              { label: t('members.col.cap'), value: m.tierLimit?.maxTier ? t(`enum.tier.${m.tierLimit.maxTier}`) : t('access.none') },
              { label: t('access.allowPins'), value: m.tierLimit?.allowPins?.join(', ') || '—' },
            ]} />
          </Container>
          {m.budgetStatus && (
            <Container header={<Header variant="h2">{t('budget.title')}</Header>}>
              <ProgressBar value={Math.min(100, Math.round((m.budgetStatus.spentUsd / m.budgetStatus.monthlyUsd) * 100))} status={m.budgetStatus.spentUsd >= m.budgetStatus.monthlyUsd ? 'error' : 'in-progress'}
                label={t('overview.budget.used', { spent: f.usd(m.budgetStatus.spentUsd), budget: f.usd(m.budgetStatus.monthlyUsd) })}
                description={`${t('overview.budget.alertAt', { percent: Math.round(m.budgetStatus.alertAt * 100) })}${m.budgetStatus.hardStop ? ` · ${t('budget.hardStop')}` : ''}`} />
            </Container>
          )}
          <ColumnLayout columns={2}>
            <Table header={<Header variant="h2">{t('members.detail.sessions')}</Header>} items={m.sessions} ariaLabels={{ tableLabel: t('members.detail.sessions') }}
              empty={<Box color="text-body-secondary">{t('state.empty.range')}</Box>}
              columnDefinitions={[
                { id: 's', header: t('decisions.col.session'), cell: (s) => <Link href={timelineHref(s.session, `user:${m.id}`, true)} onFollow={(e) => { e.preventDefault(); nav(timelineHref(s.session, `user:${m.id}`, true)) }}><Box variant="code" fontSize="body-s">{s.session.slice(0, 12)}</Box></Link>, isRowHeader: true },
                { id: 'l', header: t('decisions.col.time'), cell: (s) => <Time iso={s.last} /> },
                { id: 'n', header: t('usage.col.requests'), cell: (s) => f.int(s.requests) },
                { id: 'c', header: t('usage.col.cost'), cell: (s) => f.usd(s.costUsd) },
              ]} />
            <Table header={<Header variant="h2">{t('members.detail.history')}</Header>} items={[...m.history].reverse()} ariaLabels={{ tableLabel: t('members.detail.history') }}
              columnDefinitions={[
                { id: 't', header: t('decisions.col.time'), cell: (h) => <Time iso={h.ts} />, isRowHeader: true },
                { id: 's', header: t('members.col.status'), cell: (h) => (h.status === 'role' ? `${t('members.col.role')}: ${h.detail ?? ''}` : t(`enum.memberStatus.${h.status}`)) },
                { id: 'b', header: t('audit.col.actor'), cell: (h) => (h.by ? <Pii kind="actor">{h.by}</Pii> : '—') },
              ]} />
          </ColumnLayout>
        </SpaceBetween>
        {edit && <MemberLimitsModal m={m} onClose={() => setEdit(false)} />}
      </ContentLayout>
    )}</QueryView>
  )
}
