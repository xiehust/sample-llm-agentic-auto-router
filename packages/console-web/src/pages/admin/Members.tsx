// Members (4f §4.7): invite and manage the people who use the router. Every action is audited by the API.

import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import ButtonDropdown from '@cloudscape-design/components/button-dropdown'
import ContentLayout from '@cloudscape-design/components/content-layout'
import Form from '@cloudscape-design/components/form'
import FormField from '@cloudscape-design/components/form-field'
import Header from '@cloudscape-design/components/header'
import Input from '@cloudscape-design/components/input'
import Link from '@cloudscape-design/components/link'
import Modal from '@cloudscape-design/components/modal'
import Select from '@cloudscape-design/components/select'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import Table from '@cloudscape-design/components/table'
import TextFilter from '@cloudscape-design/components/text-filter'
import type { Member, MemberAction, Role } from '@auto-router/console-contract'
import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { ApiError } from '../../api/client.ts'
import { useInvite, useMemberAction, useMembers, usePatchMember, useDeleteMember } from '../../api/hooks.ts'
import { useFlash } from '../../app/flash.tsx'
import { useAuth } from '../../auth/AuthContext.tsx'
import { DeliveryBanner } from '../../components/delivery.tsx'
import { Empty, QueryView } from '../../components/states.tsx'
import { Pii, Time } from '../../components/values.tsx'
import { useI18n } from '../../i18n/I18n.tsx'
import type { MessageKey } from '../../i18n/messages.ts'
import { budgetOf, capOf, draftOf, LimitsForm, type LimitsDraft } from './limits.tsx'

type Dialog =
  | { kind: 'invite' }
  | { kind: 'role'; m: Member }
  | { kind: 'limits'; m: Member }
  | { kind: 'confirm'; m: Member; action: MemberAction | 'delete' }

export function memberErrorKey(e: unknown): { key: MessageKey; values?: Record<string, string> } {
  if (e instanceof ApiError) {
    if (e.code === 'email-exists') return { key: 'members.error.exists' }
    if (e.code === 'invite-failed') return { key: 'members.error.invite', values: { code: e.message } }
    if (e.code === 'cannot-disable-self') return { key: 'members.error.self' }
    if (e.code === 'last-admin') return { key: 'members.error.lastAdmin' }
    if (e.code === 'identity-delivery-failed') return { key: 'error.identity-delivery-failed' }
  }
  return { key: 'state.error.title' }
}

export function MemberStatus({ m }: { m: Member }) {
  const { t } = useI18n()
  if (m.applying) return <StatusIndicator type="in-progress">{t('members.applying')}</StatusIndicator>
  const type = m.status === 'active' ? 'success' : m.status === 'invited' ? 'pending' : 'stopped'
  return <StatusIndicator type={type}>{t(`enum.memberStatus.${m.status}`)}</StatusIndicator>
}

export default function Members() {
  const { t, f } = useI18n()
  const nav = useNavigate()
  const { claims } = useAuth()
  const flash = useFlash()
  const q = useMembers()
  const [filter, setFilter] = useState('')
  const [role, setRole] = useState<'' | Role>('')
  const [dialog, setDialog] = useState<Dialog | undefined>()
  const act = useMemberAction()
  const del = useDeleteMember()

  const run = (m: Member, action: MemberAction | 'delete') => {
    const name = m.name ?? m.email
    const done = {
      onSuccess: () => {
        setDialog(undefined)
        flash.push({ type: 'success', content: action === 'resend-invite' ? t('members.invite.sent', { email: m.email }) : action === 'sign-out' ? t('members.signOutEverywhere.done', { name }) : t('settings.saved') })
      },
      onError: (e: Error) => {
        if (action === 'sign-out') { flash.push({ type: 'error', content: t('members.signOutEverywhere.failed', { name, code: e instanceof ApiError ? e.code : 'network' }) }); return }
        const k = memberErrorKey(e); flash.push({ type: 'error', content: t(k.key, k.values) })
      },
    }
    if (action === 'delete') del.mutate({ id: m.id }, done)
    else act.mutate({ id: m.id, action }, done)
  }
  const items = (m: Member) => [
    ...(m.status === 'invited' ? [{ id: 'resend-invite', text: t('members.resendInvite') }] : []),
    { id: 'role', text: t('members.changeRole') },
    { id: 'limits', text: `${t('budget.title')} / ${t('access.title')}` },
    m.status === 'disabled' ? { id: 'enable', text: t('common.enable') } : { id: 'disable', text: t('common.disable'), disabled: m.id === claims?.sub },
    { id: 'sign-out', text: t('members.signOutEverywhere') },
    { id: 'delete', text: t('common.delete'), disabled: m.status !== 'disabled' },
  ]
  return (
    <ContentLayout header={<Header variant="h1" description={t('members.description')} actions={<Button variant="primary" onClick={() => setDialog({ kind: 'invite' })}>{t('members.invite')}</Button>}>{t('members.title')}</Header>}>
      <QueryView q={q} empty={(d) => d.items.length === 0 && <Empty title={t('members.empty')} />}>
        {(d) => {
          const banner = <DeliveryBanner d={d.identity} kind="identity" />
          const shown = d.items.filter((m) => (!role || m.role === role) && (!filter || `${m.name ?? ''} ${m.email}`.toLowerCase().includes(filter.toLowerCase())))
          return (
            <SpaceBetween size="m">
            {banner}
            <Table
              items={shown}
              ariaLabels={{ tableLabel: t('members.title') }}
              filter={<SpaceBetween direction="horizontal" size="xs">
                <TextFilter filteringText={filter} onChange={(e) => setFilter(e.detail.filteringText)} filteringPlaceholder={t('members.search')} filteringAriaLabel={t('members.search')} />
                <Select ariaLabel={t('members.col.role')} selectedOption={{ value: role, label: role ? t(`app.role.${role}`) : t('common.all') }} options={[{ value: '', label: t('common.all') }, { value: 'admin', label: t('app.role.admin') }, { value: 'member', label: t('app.role.member') }]} onChange={(e) => setRole(e.detail.selectedOption.value as '' | Role)} />
              </SpaceBetween>}
              columnDefinitions={[
                { id: 'name', header: t('members.col.name'), cell: (m) => <Link href={`/admin/members/${m.id}`} onFollow={(e) => { e.preventDefault(); nav(`/admin/members/${m.id}`) }}><Pii kind="member">{m.name ?? m.username}</Pii></Link>, isRowHeader: true },
                { id: 'email', header: t('members.col.email'), cell: (m) => <Pii kind="member-email">{m.email}</Pii> },
                { id: 'role', header: t('members.col.role'), cell: (m) => t(`app.role.${m.role}`) },
                { id: 'status', header: t('members.col.status'), cell: (m) => <MemberStatus m={m} /> },
                { id: 'created', header: t('members.col.created'), cell: (m) => <Time iso={m.createdAt} /> },
                { id: 'last', header: t('members.col.lastRequest'), cell: (m) => <Time iso={m.lastRequestAt} /> },
                { id: 'cost', header: t('members.col.costMonth'), cell: (m) => f.usd(m.costThisMonthUsd) },
                { id: 'budget', header: t('members.col.budget'), cell: (m) => (m.budget ? f.usd(m.budget.monthlyUsd) : t('budget.none')) },
                { id: 'cap', header: t('members.col.cap'), cell: (m) => (m.tierLimit?.maxTier ? t(`enum.tier.${m.tierLimit.maxTier}`) : t('access.none')) },
                {
                  id: 'actions', header: t('common.details'), cell: (m) => (
                    <ButtonDropdown variant="inline-icon" expandToViewport ariaLabel={`${t('common.details')}: ${m.email}`} items={items(m)} onItemClick={(e) => {
                      const id = e.detail.id
                      if (id === 'role') setDialog({ kind: 'role', m })
                      else if (id === 'limits') setDialog({ kind: 'limits', m })
                      else if (id === 'resend-invite' || id === 'enable') run(m, id)
                      else setDialog({ kind: 'confirm', m, action: id as MemberAction | 'delete' })
                    }} />
                  ),
                },
              ]}
            />
            </SpaceBetween>
          )
        }}
      </QueryView>
      {dialog?.kind === 'invite' && <InviteModal onClose={() => setDialog(undefined)} />}
      {dialog?.kind === 'role' && <RoleModal m={dialog.m} onClose={() => setDialog(undefined)} />}
      {dialog?.kind === 'limits' && <MemberLimitsModal m={dialog.m} onClose={() => setDialog(undefined)} />}
      {dialog?.kind === 'confirm' && (
        <ConfirmModal
          title={dialog.action === 'disable' ? t('members.disable.title', { name: dialog.m.name ?? dialog.m.email }) : dialog.action === 'delete' ? t('members.delete.title', { name: dialog.m.name ?? dialog.m.email }) : t('members.signOutEverywhere')}
          body={dialog.action === 'disable' ? t('members.disable.body', { name: dialog.m.name ?? dialog.m.email }) : dialog.action === 'delete' ? t('members.delete.body') : t('members.signOutEverywhere.confirm', { name: dialog.m.name ?? dialog.m.email })}
          danger={dialog.action !== 'sign-out'}
          loading={act.isPending || del.isPending}
          onConfirm={() => run(dialog.m, dialog.action)}
          onClose={() => setDialog(undefined)}
        />
      )}
    </ContentLayout>
  )
}

export function ConfirmModal({ title, body, onConfirm, onClose, loading, danger }: { title: string; body: ReactNode; onConfirm: () => void; onClose: () => void; loading?: boolean; danger?: boolean }) {
  const { t } = useI18n()
  return (
    <Modal visible onDismiss={onClose} header={title}
      footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
        <Button variant="link" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" loading={loading ?? false} onClick={onConfirm} ariaLabel={danger ? `${t('common.confirm')}: ${title}` : undefined}>{t('common.confirm')}</Button>
      </SpaceBetween></Box>}>
      {body}
    </Modal>
  )
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const flash = useFlash()
  const invite = useInvite()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [limits, setLimits] = useState<LimitsDraft>(draftOf(undefined, undefined))
  const [error, setError] = useState<string | undefined>()
  const emailOk = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
  const budget = budgetOf(limits)
  const submit = () => {
    if (!emailOk || !name.trim() || budget === undefined) return
    const cap = capOf(limits)
    invite.mutate({ email: email.trim(), name: name.trim(), role, ...(budget ? { budget } : {}), ...(cap ? { tierLimit: cap } : {}) }, {
      onSuccess: () => { flash.push({ type: 'success', content: t('members.invite.sent', { email }) }); onClose() },
      onError: (e) => { const k = memberErrorKey(e); setError(t(k.key, k.values)) },
    })
  }
  return (
    <Modal visible onDismiss={onClose} header={t('members.invite')} size="medium"
      footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
        <Button variant="link" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" loading={invite.isPending} disabled={!emailOk || !name.trim() || budget === undefined} onClick={submit}>{t('members.invite')}</Button>
      </SpaceBetween></Box>}>
      <Form errorText={error}>
        <SpaceBetween size="m">
          <Box color="text-body-secondary">{t('members.invite.help')}</Box>
          <FormField label={t('members.invite.email')} errorText={email && !emailOk ? t('common.requiredField') : undefined}><Input type="email" value={email} onChange={(e) => setEmail(e.detail.value)} autoFocus /></FormField>
          <FormField label={t('members.invite.name')}><Input value={name} onChange={(e) => setName(e.detail.value)} /></FormField>
          <FormField label={t('members.invite.role')}>
            <Select selectedOption={{ value: role, label: t(`app.role.${role}`) }} options={[{ value: 'member', label: t('app.role.member') }, { value: 'admin', label: t('app.role.admin') }]} onChange={(e) => setRole(e.detail.selectedOption.value as Role)} />
          </FormField>
          <LimitsForm d={limits} onChange={setLimits} />
        </SpaceBetween>
      </Form>
    </Modal>
  )
}

function RoleModal({ m, onClose }: { m: Member; onClose: () => void }) {
  const { t } = useI18n()
  const flash = useFlash()
  const patch = usePatchMember()
  const [role, setRole] = useState<Role>(m.role)
  return (
    <ConfirmModal title={t('members.changeRole')} loading={patch.isPending} onClose={onClose}
      onConfirm={() => patch.mutate({ id: m.id, patch: { role } }, {
        onSuccess: () => { flash.push({ type: 'success', content: role === 'admin' && m.role !== 'admin' ? `${t('members.roleApplies')} ${t('members.adminSignIn', { name: m.name ?? m.email })}` : t('members.roleApplies') }); onClose() },
        onError: (e) => { const k = memberErrorKey(e); flash.push({ type: 'error', content: t(k.key, k.values) }) },
      })}
      body={<SpaceBetween size="s">
        <Select ariaLabel={t('members.col.role')} selectedOption={{ value: role, label: t(`app.role.${role}`) }} options={[{ value: 'member', label: t('app.role.member') }, { value: 'admin', label: t('app.role.admin') }]} onChange={(e) => setRole(e.detail.selectedOption.value as Role)} />
        <Box color="text-body-secondary">{t('members.roleApplies')}</Box>
      </SpaceBetween>} />
  )
}

export function MemberLimitsModal({ m, onClose }: { m: Member; onClose: () => void }) {
  const { t } = useI18n()
  const flash = useFlash()
  const patch = usePatchMember()
  const [d, setD] = useState<LimitsDraft>(draftOf(m.budget, m.tierLimit))
  const budget = budgetOf(d)
  return (
    <ConfirmModal title={`${t('budget.title')} / ${t('access.title')}: ${m.name ?? m.email}`} loading={patch.isPending} onClose={onClose}
      onConfirm={() => { if (budget !== undefined) patch.mutate({ id: m.id, patch: { budget, tierLimit: capOf(d) } }, { onSuccess: () => { flash.push({ type: 'success', content: t('settings.saved') }); onClose() }, onError: () => flash.push({ type: 'error', content: t('state.error.title') }) }) }}
      body={<SpaceBetween size="s"><Box color="text-body-secondary">{t('access.help')}</Box><LimitsForm d={d} onChange={setD} /></SpaceBetween>} />
  )
}
