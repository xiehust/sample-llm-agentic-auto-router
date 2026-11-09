// Layout helpers shared by pages: a copyable code block, a chart with a table view (the accessible alternative,
// 18-frontend-stack §1.4), KPI tiles, mandatory captions and the data-page footer.

import Box from '@cloudscape-design/components/box'
import Container from '@cloudscape-design/components/container'
import CopyToClipboard from '@cloudscape-design/components/copy-to-clipboard'
import Header from '@cloudscape-design/components/header'
import SegmentedControl from '@cloudscape-design/components/segmented-control'
import SpaceBetween from '@cloudscape-design/components/space-between'
import Table, { type TableProps } from '@cloudscape-design/components/table'
import { colorBackgroundContainerHeader, colorBackgroundNotificationYellow, colorBorderDividerDefault, colorTextNotificationYellow } from '@cloudscape-design/design-tokens'
import { useState, type ReactNode } from 'react'
import { useI18n } from '../i18n/I18n.tsx'

/** `<name>` tokens in a snippet: values the reader replaces (or that this deployment did not provide). */
export const PLACEHOLDER_RE = /<([A-Za-z][^<>\n]{0,80})>/g
export const placeholdersIn = (code: string): string[] => [...new Set([...code.matchAll(PLACEHOLDER_RE)].map((m) => m[1] as string))]

/** Splits a snippet into text and highlighted placeholder parts (the copy button still copies the raw text). */
export function highlightPlaceholders(code: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  for (const m of code.matchAll(PLACEHOLDER_RE)) {
    const at = m.index ?? 0
    if (at > last) out.push(code.slice(last, at))
    out.push(<mark key={at} className="llmar-ph" data-testid="placeholder" style={{ background: colorBackgroundNotificationYellow, color: colorTextNotificationYellow }}>{m[0]}</mark>)
    last = at + m[0].length
  }
  if (last < code.length) out.push(code.slice(last))
  return out
}

/**
 * A copyable code block. Placeholders are highlighted and, when `explain` is given, listed below with what to
 * put there (`explain` returns undefined to use the generic hint).
 */
export function CodeBlock({ code, label, explain }: { code: string; label: string; explain?: (name: string) => ReactNode | undefined }) {
  const { t } = useI18n()
  const names = placeholdersIn(code)
  return (
    <div className="llmar-code">
      <SpaceBetween size="xxs">
        <Box float="right"><CopyToClipboard variant="icon" textToCopy={code} copyButtonAriaLabel={`${t('common.copy')}: ${label}`} copySuccessText={t('common.copied')} copyErrorText={t('state.error.title')} /></Box>
        <pre aria-label={label} tabIndex={0} style={{ background: colorBackgroundContainerHeader, borderColor: colorBorderDividerDefault }}><code>{highlightPlaceholders(code)}</code></pre>
        {explain && names.length > 0 && (
          <Box data-testid="replace-list">
            <Box variant="h4">{t('ext.code.replace.title')}</Box>
            <ul style={{ margin: 0, paddingInlineStart: 20 }}>
              {names.map((n) => <li key={n}><Box variant="code">{`<${n}>`}</Box>{' '}{explain(n) ?? t('ext.code.replace.other')}</li>)}
            </ul>
          </Box>
        )}
      </SpaceBetween>
    </div>
  )
}

export function ChartBox<T>({ title, chart, columns, rows, description }: {
  title: string
  description?: string
  chart: ReactNode
  columns: TableProps.ColumnDefinition<T>[]
  rows: T[]
}) {
  const { t } = useI18n()
  const [view, setView] = useState<'chart' | 'table'>('chart')
  return (
    <Container
      header={<Header variant="h2" description={description} actions={
        <SegmentedControl label={title} selectedId={view} onChange={(e) => setView(e.detail.selectedId as 'chart' | 'table')}
          options={[{ id: 'chart', text: t('ext.view.chart') }, { id: 'table', text: t('ext.view.table') }]} />
      }>{title}</Header>}
    >
      {view === 'chart' ? chart : <Table variant="embedded" columnDefinitions={columns} items={rows} ariaLabels={{ tableLabel: title }} />}
    </Container>
  )
}

export function Kpi({ label, value, help, tone }: { label: string; value: ReactNode; help?: string; tone?: 'negative' | 'positive' }) {
  return (
    <div>
      <Box variant="awsui-key-label">{label}</Box>
      <Box variant="awsui-value-large" color={tone === 'negative' ? 'text-status-error' : tone === 'positive' ? 'text-status-success' : 'inherit'}>{value}</Box>
      {help && <Box variant="small" color="text-body-secondary">{help}</Box>}
    </div>
  )
}

/** Captions that must stay visible (4f §4.3: never in a tooltip). */
export function Captions({ items }: { items: Array<ReactNode | false | undefined> }) {
  return <Box variant="small" color="text-body-secondary" data-testid="captions"><SpaceBetween size="xxs">{items.filter(Boolean).map((c, i) => <div key={i}>{c}</div>)}</SpaceBetween></Box>
}

export function PageFooter({ region, catalogVersion, dataAsOf }: { region: string; catalogVersion: string; dataAsOf?: string | undefined }) {
  const { t, f } = useI18n()
  return (
    <Box variant="small" color="text-body-secondary" margin={{ top: 'l' }}>
      <SpaceBetween direction="horizontal" size="m">
        <span>{t('app.footer.prices', { region, catalogVersion })}</span>
        {dataAsOf && <span>{t('app.footer.dataAsOf', { time: f.dateTime(dataAsOf, 'utc') })}</span>}
      </SpaceBetween>
    </Box>
  )
}
