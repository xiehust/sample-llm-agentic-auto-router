// Service clients (4f §4.8): machine callers on client credentials. The secret is shown once (create, rotate) and
// never stored by the console; the gateway authorizer is scope-only, so a new client needs no gateway change.

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import ButtonDropdown from '@cloudscape-design/components/button-dropdown'
import ContentLayout from '@cloudscape-design/components/content-layout'
import CopyToClipboard from '@cloudscape-design/components/copy-to-clipboard'
import FormField from '@cloudscape-design/components/form-field'
import Header from '@cloudscape-design/components/header'
import Input from '@cloudscape-design/components/input'
import Modal from '@cloudscape-design/components/modal'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import Table from '@cloudscape-design/components/table'
import type { ClientSecretResponse, ServiceClient } from '@auto-router/console-contract'
import { useState } from 'react'
import { useClientAction, useClients, useCreateClient, useDeleteClient, usePatchClient } from '../../api/hooks.ts'
import { useFlash } from '../../app/flash.tsx'
import { CodeBlock } from '../../components/blocks.tsx'
import { DeliveryBanner } from '../../components/delivery.tsx'
import { Empty, QueryView } from '../../components/states.tsx'
import { Mono, Time } from '../../components/values.tsx'
import { useI18n } from '../../i18n/I18n.tsx'
import { budgetOf, capOf, draftOf, LimitsForm, type LimitsDraft } from './limits.tsx'
import { ConfirmModal } from './Members.tsx'

type Dialog = { kind: 'create' } | { kind: 'limits'; c: ServiceClient } | { kind: 'confirm'; c: ServiceClient; action: 'rotate-secret' | 'disable' | 'delete' }

export default function Clients() {
  const { t, f } = useI18n()
  const flash = useFlash()
  const q = useClients()
  const act = useClientAction()
  const del = useDeleteClient()
  const [dialog, setDialog] = useState<Dialog | undefined>()
  const [secret, setSecret] = useState<ClientSecretResponse | undefined>()

  const run = (c: ServiceClient, action: 'rotate-secret' | 'disable' | 'enable' | 'delete') => {
    const fail = () => flash.push({ type: 'error', content: t('state.error.title') })
    if (action === 'delete') { del.mutate({ id: c.id }, { onSuccess: () => setDialog(undefined), onError: fail }); return }
    act.mutate({ id: c.id, action }, {
      onSuccess: (r) => { setDialog(undefined); if ('secret' in r) setSecret(r); else flash.push({ type: 'success', content: t('settings.saved') }) },
      onError: fail,
    })
  }
  return (
    <ContentLayout header={<Header variant="h1" description={t('clients.description')} actions={<Button variant="primary" onClick={() => setDialog({ kind: 'create' })}>{t('clients.create')}</Button>}>{t('clients.title')}</Header>}>
      <QueryView q={q} empty={(d) => d.items.length === 0 && <Empty title={t('clients.empty')}><Button onClick={() => setDialog({ kind: 'create' })}>{t('clients.create')}</Button></Empty>}>
        {(d) => (
          <SpaceBetween size="m">
          <DeliveryBanner d={d.identity} kind="identity" />
          <Table items={d.items} ariaLabels={{ tableLabel: t('clients.title') }}
            columnDefinitions={[
              { id: 'name', header: t('clients.col.name'), cell: (c) => <span data-pii="client" title={c.description}>{c.name}</span>, isRowHeader: true },
              { id: 'id', header: t('clients.col.clientId'), cell: (c) => <Mono>{c.id}</Mono> },
              { id: 'status', header: t('clients.col.status'), cell: (c) => <StatusIndicator type={c.status === 'active' ? 'success' : 'stopped'}>{t(`enum.memberStatus.${c.status === 'active' ? 'active' : 'disabled'}`)}</StatusIndicator> },
              { id: 'created', header: t('clients.col.created'), cell: (c) => <Time iso={c.createdAt} /> },
              { id: 'last', header: t('clients.col.lastUsed'), cell: (c) => <Time iso={c.lastUsedAt} /> },
              { id: 'cost', header: t('clients.col.costMonth'), cell: (c) => f.usd(c.costThisMonthUsd) },
              { id: 'scope', header: t('clients.col.scope'), cell: (c) => <Mono>{c.scope}</Mono> },
              { id: 'budget', header: t('clients.col.budget'), cell: (c) => (c.budget ? f.usd(c.budget.monthlyUsd) : t('budget.none')) },
              { id: 'cap', header: t('clients.col.cap'), cell: (c) => (c.tierLimit?.maxTier ? t(`enum.tier.${c.tierLimit.maxTier}`) : t('access.none')) },
              {
                id: 'actions', header: t('common.details'), cell: (c) => (
                  <ButtonDropdown variant="inline-icon" expandToViewport ariaLabel={`${t('common.details')}: ${c.name}`}
                    items={[
                      { id: 'rotate-secret', text: t('clients.rotate') },
                      { id: 'limits', text: `${t('budget.title')} / ${t('access.title')}` },
                      c.status === 'active' ? { id: 'disable', text: t('common.disable') } : { id: 'enable', text: t('common.enable') },
                      { id: 'delete', text: t('common.delete'), disabled: c.status !== 'disabled' },
                    ]}
                    onItemClick={(e) => {
                      const id = e.detail.id
                      if (id === 'limits') setDialog({ kind: 'limits', c })
                      else if (id === 'enable') run(c, 'enable')
                      else setDialog({ kind: 'confirm', c, action: id as 'rotate-secret' | 'disable' | 'delete' })
                    }} />
                ),
              },
            ]} />
          </SpaceBetween>
        )}
      </QueryView>
      {dialog?.kind === 'create' && <CreateModal onClose={() => setDialog(undefined)} onCreated={(r) => { setDialog(undefined); setSecret(r) }} />}
      {dialog?.kind === 'limits' && <ClientLimitsModal c={dialog.c} onClose={() => setDialog(undefined)} />}
      {dialog?.kind === 'confirm' && (
        <ConfirmModal title={dialog.action === 'rotate-secret' ? t('clients.rotate') : dialog.action === 'delete' ? t('common.delete') : t('common.disable')}
          body={dialog.action === 'rotate-secret' ? t('clients.rotate.body') : dialog.action === 'delete' ? t('clients.delete.body') : t('clients.disable.body')}
          loading={act.isPending || del.isPending} onConfirm={() => run(dialog.c, dialog.action)} onClose={() => setDialog(undefined)} danger />
      )}
      {secret && <SecretModal r={secret} onClose={() => setSecret(undefined)} />}
    </ContentLayout>
  )
}

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (r: ClientSecretResponse) => void }) {
  const { t } = useI18n()
  const create = useCreateClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [limits, setLimits] = useState<LimitsDraft>(draftOf(undefined, undefined))
  const [error, setError] = useState<string | undefined>()
  const nameOk = /^[A-Za-z0-9 ._-]{1,64}$/.test(name)
  const budget = budgetOf(limits)
  return (
    <Modal visible onDismiss={onClose} header={t('clients.create')}
      footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs">
        <Button variant="link" onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={!nameOk || budget === undefined} loading={create.isPending} onClick={() => {
          const cap = capOf(limits)
          create.mutate({ name, ...(description ? { description } : {}), ...(budget ? { budget } : {}), ...(cap ? { tierLimit: cap } : {}) }, { onSuccess: onCreated, onError: () => setError(t('state.error.title')) })
        }}>{t('clients.create')}</Button>
      </SpaceBetween></Box>}>
      <SpaceBetween size="m">
        {error && <Alert type="error">{error}</Alert>}
        <FormField label={t('clients.create.name')} errorText={name && !nameOk ? t('common.requiredField') : undefined}><Input value={name} onChange={(e) => setName(e.detail.value)} autoFocus /></FormField>
        <FormField label={t('clients.create.description')} secondaryControl={<Box variant="small">{t('common.optional')}</Box>}><Input value={description} onChange={(e) => setDescription(e.detail.value)} /></FormField>
        <Box color="text-body-secondary">{t('clients.limits.help')}</Box>
        <LimitsForm d={limits} onChange={setLimits} />
      </SpaceBetween>
    </Modal>
  )
}

function SecretModal({ r, onClose }: { r: ClientSecretResponse; onClose: () => void }) {
  const { t } = useI18n()
  const script = `# Machine token for ${r.client.name}: send it in both Authorization and x-api-key.
TOKEN=$(curl -sS -u "${r.client.id}:$CLIENT_SECRET" -d grant_type=client_credentials -d scope=${r.scope} \\
  "${r.tokenEndpoint}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')`
  return (
    <Modal visible onDismiss={onClose} header={t('clients.secret.title')} size="large"
      footer={<Box float="right"><Button variant="primary" onClick={onClose}>{t('common.close')}</Button></Box>}>
      <SpaceBetween size="m">
        <Alert type="warning">{t('clients.secret.once')}</Alert>
        <FormField label={t('clients.col.clientId')}><Mono>{r.client.id}</Mono></FormField>
        <FormField label={t('clients.secret.title')}>
          <SpaceBetween direction="horizontal" size="xs">
            <Box variant="code" data-testid="client-secret">{r.secret}</Box>
            <CopyToClipboard variant="icon" textToCopy={r.secret} copyButtonAriaLabel={t('common.copy')} copySuccessText={t('common.copied')} copyErrorText={t('state.error.title')} />
          </SpaceBetween>
        </FormField>
        <Box>{t('clients.secret.store')}</Box>
        <Box>{t('clients.secret.script')}</Box>
        <CodeBlock label={t('clients.secret.script')} code={script} />
      </SpaceBetween>
    </Modal>
  )
}

function ClientLimitsModal({ c, onClose }: { c: ServiceClient; onClose: () => void }) {
  const { t } = useI18n()
  const flash = useFlash()
  const patch = usePatchClient()
  const [d, setD] = useState<LimitsDraft>(draftOf(c.budget, c.tierLimit))
  const budget = budgetOf(d)
  return (
    <ConfirmModal title={`${t('budget.title')} / ${t('access.title')}: ${c.name}`} loading={patch.isPending} onClose={onClose}
      onConfirm={() => { if (budget !== undefined) patch.mutate({ id: c.id, patch: { budget, tierLimit: capOf(d) } }, { onSuccess: () => { flash.push({ type: 'success', content: t('settings.saved') }); onClose() }, onError: () => flash.push({ type: 'error', content: t('state.error.title') }) }) }}
      body={<SpaceBetween size="s"><Box color="text-body-secondary">{t('access.help')}</Box><LimitsForm d={d} onChange={setD} /></SpaceBetween>} />
  )
}
