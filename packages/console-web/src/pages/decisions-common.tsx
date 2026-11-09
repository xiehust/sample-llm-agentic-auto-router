// Shared pieces of the Decisions list and the session timeline: row icons and the summary columns.

import Box from '@cloudscape-design/components/box'
import Link from '@cloudscape-design/components/link'
import SpaceBetween from '@cloudscape-design/components/space-between'
import type { TableProps } from '@cloudscape-design/components/table'
import type { DecisionAction, RecordSummary } from '@auto-router/console-contract'
import { useNavigate } from 'react-router'
import { codeLabel } from '../components/codes.ts'
import { Caller, Pct, TierBadge, Time } from '../components/values.tsx'
import { useI18n } from '../i18n/I18n.tsx'
import type { Translate } from '../i18n/messages.ts'

const ACTIONS: readonly DecisionAction[] = ['initialize', 'retain', 'switch', 'pin']

/** The action in the deck's terms (enum.action.*: Start / Keep / Switch / Pin, 4f); a code the deck lacks via the code table. */
export function actionLabel(t: Translate, action: string, locale: Parameters<typeof codeLabel>[2]): string {
  return (ACTIONS as readonly string[]).includes(action) ? t(`enum.action.${action as DecisionAction}`) : codeLabel('decision.action', action, locale).label
}
import { shortModel } from './scope.ts'

export function RowIcons({ r }: { r: RecordSummary }) {
  const { t } = useI18n()
  const icons: Array<[string, string]> = []
  if (r.flags.failover) icons.push(['⇄', t('decisions.icon.failover')])
  if (r.flags.miss) icons.push(['◌', `${t('decisions.icon.miss')}: ${t(`enum.missReason.${r.flags.miss}`)}`])
  if (r.flags.assessor) icons.push(['◆', `${t('decisions.icon.assessor')}: ${r.flags.assessor}`])
  if (r.flags.hint) icons.push(['✎', t('decisions.icon.hint')])
  if (r.flags.aborted) icons.push(['✕', t('decisions.icon.aborted')])
  if (r.flags.capped) icons.push(['▼', t('savings.capRow')])
  return <span>{icons.map(([g, label]) => <span key={label} title={label} aria-label={label} role="img" style={{ marginRight: 4 }}>{g}</span>)}</span>
}

/** Detail link carrying the row's ts (and caller for admins), so the API reads the record by key. */
export const recordHref = (r: Pick<RecordSummary, 'reqId' | 'ts' | 'caller'>, admin: boolean) => {
  const q = new URLSearchParams({ ts: r.ts })
  if (admin && r.caller) q.set('caller', r.caller.key)
  return `/decisions/${encodeURIComponent(r.reqId)}?${q}`
}

export const timelineHref = (session: string, callerKey: string | undefined, admin: boolean) =>
  `/sessions/${encodeURIComponent(session)}${admin && callerKey ? `?caller=${encodeURIComponent(callerKey)}` : ''}`

export function useRecordColumns(admin: boolean): TableProps.ColumnDefinition<RecordSummary>[] {
  const { t, f, locale } = useI18n()
  const nav = useNavigate()
  const go = (href: string) => (e: CustomEvent) => { e.preventDefault(); nav(href) }
  return [
    { id: 'time', header: t('decisions.col.time'), cell: (r) => <Link href={recordHref(r, admin)} onFollow={go(recordHref(r, admin))}><Time iso={r.ts} /></Link>, isRowHeader: true },
    ...(admin ? [{ id: 'caller', header: t('decisions.col.caller'), cell: (r: RecordSummary) => <Caller c={r.caller} /> }] : []),
    { id: 'session', header: t('decisions.col.session'), cell: (r) => (r.session ? <Link href={timelineHref(r.session, r.caller?.key, admin)} onFollow={go(timelineHref(r.session, r.caller?.key, admin))}><Box variant="code" fontSize="body-s">{r.session.slice(0, 8)}</Box></Link> : '—') },
    { id: 'dialect', header: t('decisions.col.dialect'), cell: (r) => (r.dialect ? t(`enum.dialect.${r.dialect}`) : '—') },
    { id: 'requested', header: t('decisions.col.requested'), cell: (r) => (r.requested === 'other' ? t('decisions.requested.other') : shortModel(r.requested)) },
    { id: 'action', header: t('decisions.col.action'), cell: (r) => (r.action ? actionLabel(t, r.action, locale) : r.errorCode ? codeLabel('request.reason', r.errorCode, locale).label : '—') },
    { id: 'point', header: t('decisions.col.point'), cell: (r) => (r.point ? t(`enum.point.${r.point}`) : '—') },
    { id: 'served', header: t('decisions.col.servedModel'), cell: (r) => shortModel(r.servedModel) },
    { id: 'tier', header: t('decisions.col.tier'), cell: (r) => <TierBadge tier={r.tier} /> },
    { id: 'tokens', header: t('decisions.col.tokens'), cell: (r) => (r.promptTokens !== undefined ? `${f.compact(r.promptTokens)} / ${f.compact(r.outputTokens ?? 0)}` : '—') },
    { id: 'cost', header: t('decisions.col.cost'), cell: (r) => (r.costUsd !== undefined ? f.usdPrecise(r.costUsd) : '—') },
    { id: 'hit', header: t('decisions.col.hitRate'), cell: (r) => <Pct v={r.hitRate} /> },
    { id: 'status', header: t('decisions.col.status'), cell: (r) => <SpaceBetween direction="horizontal" size="xxs"><span>{r.status}</span><RowIcons r={r} /></SpaceBetween> },
  ]
}
