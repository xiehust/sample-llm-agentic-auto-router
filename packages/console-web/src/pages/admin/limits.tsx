// Budget and tier-limit editor shared by Members and Service clients (design 0.15–0.16).

import Checkbox from '@cloudscape-design/components/checkbox'
import FormField from '@cloudscape-design/components/form-field'
import Input from '@cloudscape-design/components/input'
import Select from '@cloudscape-design/components/select'
import SpaceBetween from '@cloudscape-design/components/space-between'
import Textarea from '@cloudscape-design/components/textarea'
import type { Budget, Cap, Tier } from '@auto-router/console-contract'
import Alert from '@cloudscape-design/components/alert'
import Box from '@cloudscape-design/components/box'
import { useProfile } from '../../api/hooks.ts'
import { useI18n } from '../../i18n/I18n.tsx'

export interface LimitsDraft { budgetOn: boolean; usd: string; alertAt: string; hardStop: boolean; maxTier: Tier | ''; pins: string }

export const draftOf = (b: Budget | undefined, c: Cap | undefined): LimitsDraft => ({
  budgetOn: !!b, usd: b ? String(b.monthlyUsd) : '', alertAt: b ? String(Math.round(b.alertAt * 100)) : '80', hardStop: b?.hardStop ?? false,
  maxTier: c?.maxTier ?? '', pins: (c?.allowPins ?? []).join('\n'),
})

/** undefined when invalid; null clears. */
export function budgetOf(d: LimitsDraft): Budget | null | undefined {
  if (!d.budgetOn) return null
  const usd = Number(d.usd)
  const pct = Number(d.alertAt)
  if (!(usd > 0) || !(pct > 0 && pct <= 100)) return undefined
  return { monthlyUsd: usd, alertAt: pct / 100, hardStop: d.hardStop }
}

export function capOf(d: LimitsDraft): Cap | null {
  const pins = d.pins.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  if (!d.maxTier && pins.length === 0) return null
  return { ...(d.maxTier ? { maxTier: d.maxTier } : {}), ...(pins.length ? { allowPins: pins } : {}) }
}

export function LimitsForm({ d, onChange }: { d: LimitsDraft; onChange: (d: LimitsDraft) => void }) {
  const { t } = useI18n()
  const tiers: Array<{ value: Tier | ''; label: string }> = [{ value: '', label: t('access.none') }, ...(['fast', 'standard', 'frontier'] as Tier[]).map((x) => ({ value: x, label: t(`enum.tier.${x}`) }))]
  const invalidBudget = d.budgetOn && budgetOf(d) === undefined
  const advisory = useProfile().data?.deployment.identityMode !== 'require'
  return (
    <SpaceBetween size="m">
      {advisory && <Alert type="info">{t('budget.advisory')} {t('access.advisory')}</Alert>}
      <Box variant="small" color="text-body-secondary">{t('budget.spendIncludes')}</Box>
      <Checkbox checked={d.budgetOn} onChange={(e) => onChange({ ...d, budgetOn: e.detail.checked })}>{t('budget.monthly')}</Checkbox>
      {d.budgetOn && (
        <SpaceBetween size="s">
          <FormField label={t('budget.monthly')} errorText={invalidBudget ? t('common.requiredField') : undefined}><Input type="number" inputMode="decimal" value={d.usd} onChange={(e) => onChange({ ...d, usd: e.detail.value })} /></FormField>
          <FormField label={t('budget.alertThreshold')}><Input type="number" inputMode="numeric" value={d.alertAt} onChange={(e) => onChange({ ...d, alertAt: e.detail.value })} /></FormField>
          <Checkbox checked={d.hardStop} onChange={(e) => onChange({ ...d, hardStop: e.detail.checked })} description={t('budget.hardStop.help')}>{t('budget.hardStop')}</Checkbox>
        </SpaceBetween>
      )}
      <FormField label={t('access.override')} description={t('access.precedence')}>
        <Select ariaLabel={t('access.maxTier')} options={tiers} selectedOption={tiers.find((o) => o.value === d.maxTier) ?? null} onChange={(e) => onChange({ ...d, maxTier: e.detail.selectedOption.value as Tier | '' })} />
      </FormField>
      <FormField label={t('access.allowPins')} description={t('access.allowPins.help')}>
        <Textarea rows={2} value={d.pins} onChange={(e) => onChange({ ...d, pins: e.detail.value })} />
      </FormField>
    </SpaceBetween>
  )
}
