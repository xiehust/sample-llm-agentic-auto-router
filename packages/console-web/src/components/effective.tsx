// Effective configuration (0d-effective-config §4): each runtime setting with where its value comes from, and
// what the running router tasks report. 'unknown' (config/baked.json unreadable) is shown as unknown, never guessed.

import Alert from '@cloudscape-design/components/alert'
import Badge from '@cloudscape-design/components/badge'
import Box from '@cloudscape-design/components/box'
import Container from '@cloudscape-design/components/container'
import ExpandableSection from '@cloudscape-design/components/expandable-section'
import Header from '@cloudscape-design/components/header'
import KeyValuePairs from '@cloudscape-design/components/key-value-pairs'
import SpaceBetween from '@cloudscape-design/components/space-between'
import StatusIndicator from '@cloudscape-design/components/status-indicator'
import Table from '@cloudscape-design/components/table'
import type { ConfigState, EffectiveSetting, EffectiveSettings, ReportedConfig } from '@auto-router/console-contract'
import type { ReactNode } from 'react'
import { useI18n } from '../i18n/I18n.tsx'
import type { MessageKey } from '../i18n/messages.ts'
import { shortModel } from '../pages/scope.ts'
import { Mono, Time } from './values.tsx'

/** The n of a console version '<n>-<compact ISO>' or a baked '0-baked.<sha8>'. */
export const versionNumber = (v: string | undefined): string => v?.match(/^(\d+)-/)?.[1] ?? '?'

/** "from config v#n" / "deploy default" / unknown, with the full version on hover. */
export function SourceBadge({ s }: { s: EffectiveSetting<unknown> | undefined }) {
  const { t } = useI18n()
  if (!s) return null
  if (s.source === 'document') return <span title={t('ext.source.document.title', { version: s.version ?? '?' })}><Badge color="blue">{t('ext.source.document', { n: versionNumber(s.version) })}</Badge></span>
  if (s.source === 'baked') return <span title={t('ext.source.baked.title', { version: s.version ?? '?' })}><Badge color="grey">{t('ext.source.baked')}</Badge></span>
  return <span title={t('ext.source.unknown.title')}><StatusIndicator type="warning">{t('common.unknown')}</StatusIndicator></span>
}

/** A setting's value and its source; an unknown value renders only the unknown badge. */
export function EffectiveValue<T>({ s, render }: { s: EffectiveSetting<T> | undefined; render: (v: T) => ReactNode }) {
  if (!s) return null
  return (
    <SpaceBetween direction="horizontal" size="xs" alignItems="center">
      {s.source !== 'unknown' && s.value !== undefined && <span>{render(s.value)}</span>}
      <SourceBadge s={s} />
    </SpaceBetween>
  )
}

type Field = 'identityMode' | 'routerMode' | 'policyVersion' | 'assessorMode' | 'assessorPack' | 'assessorModel'
const LABEL: Record<Field, MessageKey> = {
  identityMode: 'settings.identity', routerMode: 'ext.effective.routerMode', policyVersion: 'ext.effective.policyVersion',
  assessorMode: 'ext.effective.assessorMode', assessorPack: 'ext.effective.assessorPack', assessorModel: 'ext.effective.assessorModel',
}
const IDENTITY = ['off', 'observe', 'require'] as const
const MODES = ['off', 'observe', 'auto'] as const
/** Reported field (router config line `effective`) → the configured setting it is compared with. */
const REPORTED: Array<[keyof NonNullable<ReportedConfig['effective']>, Field]> = [['identityMode', 'identityMode'], ['assessorMode', 'assessorMode'], ['policyVersion', 'policyVersion'], ['mode', 'routerMode']]

export const anyUnknown = (e: EffectiveSettings | undefined): boolean => !!e && (Object.keys(LABEL) as Field[]).some((k) => e[k]?.source === 'unknown')

/** Short labels for known codes (identity 'observe' → "Observe", the full sentence on hover); other values as is. */
function useLabels() {
  const { t } = useI18n()
  return {
    identity: (v: string | undefined) => ((IDENTITY as readonly string[]).includes(v ?? '') ? <span title={t(`enum.identity.${v as typeof IDENTITY[number]}`)}>{t(`ext.identity.short.${v as typeof IDENTITY[number]}`)}</span> : v ?? '—'),
    mode: (v: string | undefined) => ((MODES as readonly string[]).includes(v ?? '') ? t(`enum.mode.${v as typeof MODES[number]}`) : v ?? '—'),
  }
}

/** The settings in effect, the unknown notice, and the router-reported comparison (config page). */
export function EffectivePanel({ s }: { s: ConfigState }) {
  const { t } = useI18n()
  const label = useLabels()
  const e = s.effective
  if (!e) return null
  const v = (k: Field): ReactNode => {
    switch (k) {
      case 'identityMode': return <EffectiveValue s={e.identityMode} render={label.identity} />
      case 'routerMode': return <EffectiveValue s={e.routerMode} render={label.mode} />
      case 'assessorMode': return <EffectiveValue s={e.assessorMode} render={label.mode} />
      case 'assessorModel': return <EffectiveValue s={e.assessorModel} render={(x) => <Mono>{shortModel(x)}</Mono>} />
      default: return <EffectiveValue s={e[k]} render={(x) => <Mono>{x}</Mono>} />
    }
  }
  return (
    <SpaceBetween size="l">
      {anyUnknown(e) && <Alert type="warning">{t('ext.effective.unknown')}</Alert>}
      <ReportedMismatch e={e} reported={s.reported} />
      <Container header={<Header variant="h2" description={t('ext.effective.description')}>{t('ext.effective.title')}</Header>}>
        <SpaceBetween size="m">
          <KeyValuePairs columns={3} items={(Object.keys(LABEL) as Field[]).map((k) => ({ label: t(LABEL[k]), value: v(k) }))} />
          <ReportedTable reported={s.reported} />
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  )
}

/** Fields where a task's report differs from the configured value (only where both are known). */
export function differences(r: ReportedConfig, e: EffectiveSettings): Array<{ field: Field; reported: string; configured: string }> {
  const out: Array<{ field: Field; reported: string; configured: string }> = []
  for (const [rk, field] of REPORTED) {
    const reported = r.effective?.[rk]
    const configured = e[field].value
    if (reported !== undefined && configured !== undefined && reported !== configured) out.push({ field, reported, configured: String(configured) })
  }
  return out
}

/** Warning when a running task reports settings other than the configured ones (`matches === false`). */
export function ReportedMismatch({ e, reported }: { e: EffectiveSettings; reported: ReportedConfig[] | undefined }) {
  const { t } = useI18n()
  const off = (reported ?? []).filter((r) => r.matches === false)
  if (off.length === 0) return null
  return (
    <Alert type="warning" header={t('ext.reported.mismatch', { count: off.length })}>
      {off.map((r) => (
        <div key={r.task}>
          <Mono>{r.task}</Mono>{' '}
          {differences(r, e).map((d) => t('ext.reported.differs', { field: t(LABEL[d.field]), reported: d.reported, configured: d.configured })).join(' · ')}
        </div>
      ))}
    </Alert>
  )
}

function ReportedTable({ reported }: { reported: ReportedConfig[] | undefined }) {
  const { t } = useI18n()
  const label = useLabels()
  const items = reported ?? []
  return (
    <ExpandableSection headerText={t('ext.reported.title')} headerDescription={t('ext.reported.description')} defaultExpanded={items.some((r) => r.matches === false)}>
      <Table
        variant="embedded"
        items={items}
        ariaLabels={{ tableLabel: t('ext.reported.title') }}
        empty={<Box color="text-body-secondary">{t('ext.reported.empty')}</Box>}
        columnDefinitions={[
          { id: 'task', header: t('ext.reported.col.task'), cell: (r) => <Mono>{r.task}</Mono>, isRowHeader: true },
          { id: 'matches', header: t('ext.reported.col.matches'), cell: (r) => r.matches === true ? <StatusIndicator type="success">{t('ext.reported.matches.yes')}</StatusIndicator> : r.matches === false ? <StatusIndicator type="warning">{t('ext.reported.matches.no')}</StatusIndicator> : <StatusIndicator type="stopped">{t('ext.reported.matches.unknown')}</StatusIndicator> },
          { id: 'identity', header: t('settings.identity'), cell: (r) => label.identity(r.effective?.identityMode) },
          { id: 'mode', header: t('ext.effective.routerMode'), cell: (r) => label.mode(r.effective?.mode) },
          { id: 'assessor', header: t('ext.effective.assessorMode'), cell: (r) => label.mode(r.effective?.assessorMode) },
          { id: 'policy', header: t('ext.effective.policyVersion'), cell: (r) => <Mono>{r.effective?.policyVersion}</Mono> },
          { id: 'version', header: t('ext.reported.col.configVersion'), cell: (r) => <Mono>{r.configVersion}</Mono> },
          { id: 'at', header: t('ext.reported.col.at'), cell: (r) => <Time iso={r.at} /> },
        ]}
      />
    </ExpandableSection>
  )
}
