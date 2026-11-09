// Settings: Deployment (admin, 4f §4.14). Identity mode is part of the config document (a new config version);
// retention and the default savings baseline are console settings; the default budget lives in /api/admin/budgets.
// Deploy-time facts are read-only.

import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import Button from '@cloudscape-design/components/button'
import Checkbox from '@cloudscape-design/components/checkbox'
import Container from '@cloudscape-design/components/container'
import ContentLayout from '@cloudscape-design/components/content-layout'
import FormField from '@cloudscape-design/components/form-field'
import Header from '@cloudscape-design/components/header'
import Input from '@cloudscape-design/components/input'
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs'
import RadioGroup from '@cloudscape-design/components/radio-group'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import type { Baseline, Budget, IdentityKeysReason, IdentityMode } from '@auto-router/console-contract'
import { useEffect, useState } from 'react'
import { ApiError } from '../../api/client.ts'
import { useActivate, useBudgets, useConfig, usePatchSettings, usePutBudgets, useSettings, useUsage } from '../../api/hooks.ts'
import { useFlash } from '../../app/flash.tsx'
import { DeliveryBanner } from '../../components/delivery.tsx'
import { SourceBadge } from '../../components/effective.tsx'
import { ChoiceFilter } from '../../components/filters.tsx'
import { resolveRange } from '../../components/range.tsx'
import { ErrorState, QueryView, useMutationErrorText } from '../../components/states.tsx'
import { Mono } from '../../components/values.tsx'
import { useI18n } from '../../i18n/I18n.tsx'
import type { MessageKey, Translate } from '../../i18n/messages.ts'

const KEYS_REASON: Record<IdentityKeysReason, MessageKey> = {
  'no-fresh-task': 'ext.identityKeys.reason.noFreshTask',
  partial: 'ext.identityKeys.reason.partial',
  'not-configured': 'ext.identityKeys.reason.notConfigured',
  'task-without-keys': 'ext.identityKeys.reason.taskWithoutKeys',
}

/** Why Require is refused (73's IdentityKeysReason, from the router state or the 422 refusal); undefined for an unknown reason. */
export function keysReasonText(t: Translate, reason: string | undefined, task: string | undefined): string | undefined {
  const k = reason ? KEYS_REASON[reason as IdentityKeysReason] : undefined
  return k ? t(k, { task: task ?? '—' }) : undefined
}

const BASE_LABEL: Record<Baseline, MessageKey> = { static: 'savings.baseline.static', standard: 'savings.baseline.standard', frontier: 'savings.baseline.frontier', 'observe-default': 'savings.baseline.observeDefault' }

export default function DeploymentSettings() {
  const { t } = useI18n()
  const settings = useSettings()
  return (
    <ContentLayout header={<Header variant="h1">{t('settings.tab.deployment')}</Header>}>
      <SpaceBetween size="l">
        {settings.data && <DeliveryBanner d={settings.data.identity} kind="identity" />}
        <IdentityCard />
        <QueryView q={settings}>{(s) => <SettingsCard defaultBaseline={s.defaultBaseline} />}</QueryView>
        <BudgetCard />
        <QueryView q={settings}>{(s) => (
          <Container header={<Header variant="h2" description={t('settings.cdkOnly')}>{t('ext.settings.deployFacts')}</Header>}>
            <KeyValuePairs columns={3} items={[
              { label: t('settings.retention'), value: <SpaceBetween size="xxxs"><span>{s.readOnly.retentionDays}</span><Box variant="small" color="text-body-secondary">{t('settings.retention.help')}</Box></SpaceBetween> },
              { label: t('settings.refreshDays'), value: String(s.readOnly.refreshDays) },
              { label: t('settings.mfa'), value: <Box variant="small">{t('settings.mfa.off')}</Box> },
              { label: t('settings.catalog'), value: <Mono>{`${s.readOnly.catalog.region} ${s.readOnly.catalog.version}`}</Mono> },
              { label: t('settings.universe'), value: <SpaceBetween size="xxxs">{s.readOnly.universe.map((m) => <Mono key={m}>{m}</Mono>)}</SpaceBetween> },
            ]} />
          </Container>
        )}</QueryView>
      </SpaceBetween>
    </ContentLayout>
  )
}

function IdentityCard() {
  const { t } = useI18n()
  const flash = useFlash()
  const cfg = useConfig()
  const activate = useActivate()
  const errorText = useMutationErrorText()
  const day = resolveRange(new URLSearchParams({ range: '24h' }))
  const callers = useUsage('admin', { from: day.from, to: day.to, groupBy: 'caller' })
  // The effective mode (active version, else the deploy default); undefined while unknown: never guessed as 'off' (0d).
  const eff = cfg.data?.effective?.identityMode
  const current: IdentityMode | undefined = eff ? eff.value : cfg.data?.active.document.identity?.mode
  const [mode, setMode] = useState<IdentityMode | undefined>(current)
  useEffect(() => setMode(current), [current])
  // Signing keys (73): per-task evidence when console-api sends it, else the boolean alone.
  const keys = cfg.data?.router.identityKeys
  const keysLoaded = keys ? keys.loaded : cfg.data?.router.identityKeysLoaded !== false
  const blockedReason = keysLoaded ? undefined : keysReasonText(t, keys?.reason, keys?.task)
  const total = callers.data?.totals.requests ?? 0
  const unattributed = callers.data?.rows.find((r) => r.key === 'none')?.requests ?? 0
  const save = () => {
    const a = cfg.data?.active
    if (!a || !mode) return
    const from = cfg.data?.effective?.document ?? a.document
    activate.mutate({ document: { ...from, identity: { mode } }, comment: `identity mode ${current ?? 'unknown'} -> ${mode}`, baseVersion: a.version }, {
      onSuccess: () => flash.push({ type: 'success', content: t('settings.saved') }),
      onError: (e) => flash.push({ type: 'error', content:
        e instanceof ApiError && e.code === 'config-version-moved' ? t('config.conflict', { version: '' })
        : e instanceof ApiError && e.code === 'identity-keys-not-loaded' ? [t('settings.identity.requireBlocked'), keysReasonText(t, e.reason, keys?.task)].filter(Boolean).join(' ')
        : errorText(e) }),
    })
  }
  return (
    <Container header={<Header variant="h2" description={t('settings.identity.help')} actions={<Button variant="primary" disabled={!cfg.data || !mode || mode === current || (mode === 'require' && !keysLoaded)} loading={activate.isPending} onClick={save}>{t('common.save')}</Button>}>{t('settings.identity')}</Header>}>
      {cfg.error && !cfg.data ? <ErrorState error={cfg.error} onRetry={() => void cfg.refetch()} inline notFound="config" /> : <SpaceBetween size="s">
        <SourceBadge s={eff} />
        {keys && (
          <StatusIndicator type={keys.loaded ? 'success' : 'warning'} data-testid="identity-keys">
            {t('ext.identityKeys.count', { withKeys: keys.withKeys, total: keys.running ?? keys.fresh })}
          </StatusIndicator>
        )}
        <RadioGroup value={mode ?? null} onChange={(e) => setMode(e.detail.value as IdentityMode)} items={(['off', 'observe', 'require'] as IdentityMode[]).map((m) => ({
          value: m, label: t(`enum.identity.${m}`),
          // The Require option says why it would be refused (73's reason), before anyone picks it.
          ...(m === 'require' && current !== 'require' && blockedReason ? { description: blockedReason } : {}),
        }))} />
        {mode !== 'require' && <Box color="text-body-secondary">{t('settings.identity.observeNote')}</Box>}
        {mode === 'require' && current !== 'require' && !keysLoaded && <Alert type="error" data-testid="require-blocked">{t('settings.identity.requireBlocked')}{blockedReason ? ` ${blockedReason}` : ''}</Alert>}
        {mode === 'require' && current !== 'require' && total > 0 && unattributed > 0 && (
          <Alert type="warning">{t('settings.identity.requireWarning')} {t('overview.alert.unattributed', { percent: Math.round((unattributed / total) * 100) })}</Alert>
        )}
      </SpaceBetween>}
    </Container>
  )
}

/** Console settings only; retention is the deploy parameter recordRetentionDays (shown with the deploy facts). */
function SettingsCard({ defaultBaseline }: { defaultBaseline: Baseline }) {
  const { t } = useI18n()
  const flash = useFlash()
  const patch = usePatchSettings()
  const [baseline, setBaseline] = useState<Baseline>(defaultBaseline)
  return (
    <Container header={<Header variant="h2" actions={<Button variant="primary" disabled={baseline === defaultBaseline} loading={patch.isPending} onClick={() => patch.mutate({ defaultBaseline: baseline }, {
      onSuccess: () => flash.push({ type: 'success', content: t('settings.saved') }),
      onError: () => flash.push({ type: 'error', content: t('state.error.title') }),
    })}>{t('common.save')}</Button>}>{t('ext.settings.records')}</Header>}>
      <SpaceBetween size="m">
        <FormField label={t('settings.defaultBaseline')}>
          <ChoiceFilter label={t('settings.defaultBaseline')} value={baseline} onChange={setBaseline} options={(Object.keys(BASE_LABEL) as Baseline[]).map((b) => ({ value: b, label: t(BASE_LABEL[b]) }))} />
        </FormField>
      </SpaceBetween>
    </Container>
  )
}

export interface BudgetFormValues { on: boolean; usd: string; alertAt: string; hard: boolean }

/** The default-budget form against the saved budget: what Save would send, whether that is valid, and whether it changes anything. */
export function budgetForm(saved: Budget | undefined, f: BudgetFormValues): { next: Budget | null; invalid: boolean; dirty: boolean } {
  const amount = Number(f.usd)
  const pct = Number(f.alertAt)
  const invalid = f.on && (!(amount > 0) || !(pct > 0 && pct <= 100))
  const next = f.on ? { monthlyUsd: amount, alertAt: pct / 100, hardStop: f.hard } : null
  const dirty = f.on
    ? !saved || amount !== saved.monthlyUsd || pct !== Math.round(saved.alertAt * 100) || f.hard !== saved.hardStop
    : saved !== undefined
  return { next, invalid, dirty }
}

function BudgetCard() {
  const { t } = useI18n()
  const flash = useFlash()
  const q = useBudgets()
  const put = usePutBudgets()
  const [on, setOn] = useState(false)
  const [usd, setUsd] = useState('')
  const [alertAt, setAlertAt] = useState('80')
  const [hard, setHard] = useState(false)
  useEffect(() => {
    const d = q.data?.default
    setOn(!!d); setUsd(d ? String(d.monthlyUsd) : ''); setAlertAt(d ? String(Math.round(d.alertAt * 100)) : '80'); setHard(d?.hardStop ?? false)
  }, [q.data])
  // Save stays disabled until the budgets have loaded and the form differs from them and is valid.
  const form = budgetForm(q.data?.default, { on, usd, alertAt, hard })
  return (
    <Container header={<Header variant="h2" description={t('budget.hardStop.help')} actions={<Button data-testid="budget-save" variant="primary" disabled={!q.data || !form.dirty || form.invalid} loading={put.isPending} onClick={() => put.mutate({ default: form.next }, {
      onSuccess: () => flash.push({ type: 'success', content: t('settings.saved') }),
      onError: () => flash.push({ type: 'error', content: t('state.error.title') }),
    })}>{t('common.save')}</Button>}>{t('budget.default')}</Header>}>
      <SpaceBetween size="m">
        <Checkbox checked={on} onChange={(e) => setOn(e.detail.checked)}>{t('budget.default')}</Checkbox>
        {on && <>
          <FormField label={t('budget.monthly')}><Input type="number" inputMode="decimal" value={usd} onChange={(e) => setUsd(e.detail.value)} /></FormField>
          <FormField label={t('budget.alertThreshold')}><Input type="number" inputMode="numeric" value={alertAt} onChange={(e) => setAlertAt(e.detail.value)} /></FormField>
          <Checkbox checked={hard} onChange={(e) => setHard(e.detail.checked)}>{t('budget.hardStop')}</Checkbox>
        </>}
      </SpaceBetween>
    </Container>
  )
}
