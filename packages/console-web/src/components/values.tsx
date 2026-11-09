// Small value renderers bound to the active locale and the time-display preference.

import Badge from '@cloudscape-design/components/badge'
import Box from '@cloudscape-design/components/box'
import type { CallerRef, Tier } from '@auto-router/console-contract'
import type { ReactNode } from 'react'
import { useI18n } from '../i18n/I18n.tsx'
import type { Locale } from '../i18n/locale.ts'
import { codeLabel } from './codes.ts'
import { usePrefs } from '../prefs/prefs.tsx'

export function Usd({ v, precise }: { v: number | undefined; precise?: boolean }) {
  const { f, t } = useI18n()
  if (v === undefined) return <>{t('common.notAvailable')}</>
  return <>{precise ? f.usdPrecise(v) : f.usd(v)}</>
}

export function Tokens({ v }: { v: number | undefined }) {
  const { f, t } = useI18n()
  return <>{v === undefined ? t('common.notAvailable') : f.compact(v)}</>
}

export function Pct({ v }: { v: number | undefined }) {
  const { f, t } = useI18n()
  return <>{v === undefined ? t('common.notAvailable') : f.percent(v)}</>
}

export function useTime() {
  const { f } = useI18n()
  const { prefs } = usePrefs()
  return (iso: string) => f.dateTime(iso, prefs.time)
}

/** A timestamp in the preferred zone, with the other one on hover (4f §1.5). */
export function Time({ iso }: { iso: string | undefined }) {
  const { f, t } = useI18n()
  const { prefs } = usePrefs()
  if (!iso) return <>{t('common.notAvailable')}</>
  const other = prefs.time === 'utc' ? 'local' : 'utc'
  return <time dateTime={iso} title={f.dateTime(iso, other)}>{f.dateTime(iso, prefs.time)}</time>
}

export function TierBadge({ tier }: { tier: Tier | undefined }) {
  const { t } = useI18n()
  if (!tier) return null
  const color = tier === 'frontier' ? 'red' : tier === 'fast' ? 'green' : 'blue'
  return <Badge color={color}>{t(`enum.tier.${tier}`)}</Badge>
}

/** Short label for principal 'none' (73's code table); term.unattributed is the glossary sentence for the tooltip. */
export const unattributedLabel = (locale: Locale): string => codeLabel('principal.kind', 'none', locale).label

/** Admin views: a caller by name (e-mail in the tooltip); members always see "You". */
export function Caller({ c, self }: { c: CallerRef | undefined; self?: boolean }) {
  const { t, locale } = useI18n()
  if (self) return <>{t('common.you')}</>
  if (!c || c.kind === 'none') return <span title={t('term.unattributed')}>{unattributedLabel(locale)}</span>
  const label = c.name ?? c.key
  // data-pii: screenshots for the docs mask caller names (e2e/deployed.spec.ts).
  return <span data-pii="caller" title={c.email ?? c.key}>{c.deleted ? <Box variant="span" color="text-status-inactive">{label}</Box> : label}</span>
}

/**
 * A message with one principal (author, actor, caller) inside it: that part is wrapped in data-pii so the docs
 * screenshots mask it (e2e/deployed.spec.ts). When the value is not in the text, the text renders as is.
 */
export function WithPii({ text, value, kind }: { text: string; value: string | undefined; kind: string }) {
  const i = value ? text.indexOf(value) : -1
  if (!value || i < 0) return <>{text}</>
  return <>{text.slice(0, i)}<span data-pii={kind}>{value}</span>{text.slice(i + value.length)}</>
}

/** A principal shown on its own (author, member name or e-mail, client name): masked in the docs screenshots. */
export function Pii({ kind, children }: { kind: string; children: ReactNode }) {
  return <span data-pii={kind}>{children}</span>
}

export function Mono({ children }: { children: string | undefined }) {
  return <Box variant="code" fontSize="body-s">{children ?? '—'}</Box>
}
