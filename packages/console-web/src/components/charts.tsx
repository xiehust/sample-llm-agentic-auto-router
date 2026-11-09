// Classic Cloudscape charts only (no Highcharts-based package: 18-frontend-stack §1.1). Every chart has a table view
// (ChartBox) and locale formatters; days on the x axis are UTC.

import BarChart from '@cloudscape-design/components/bar-chart'
import LineChart from '@cloudscape-design/components/line-chart'
import { daysBetween, type DailyPoint, type Series } from '@auto-router/console-contract'
import { useI18n } from '../i18n/I18n.tsx'

const totalTokens = (p: DailyPoint) => p.tokens.uncached + p.tokens.cacheRead + Object.values(p.tokens.cacheWrite).reduce((a, b) => a + (b ?? 0), 0) + p.tokens.output

/** Stacked bars per UTC day, one series per key (served model, tier, API or caller). */
export function StackedDaily({ points, from, to, metric, label, seriesLabel }: {
  points: DailyPoint[]
  from: string
  to: string
  metric: 'cost' | 'tokens'
  label: string
  seriesLabel?: (key: string) => string
}) {
  const { f, t } = useI18n()
  const days = daysBetween(from, to)
  const keys = [...new Set(points.map((p) => p.series))]
  const value = (p: DailyPoint) => (metric === 'cost' ? p.costUsd : totalTokens(p))
  const series = keys.map((k) => ({
    title: seriesLabel?.(k) ?? k,
    type: 'bar' as const,
    data: days.map((d) => ({ x: d, y: points.filter((p) => p.day === d && p.series === k).reduce((a, p) => a + value(p), 0) })),
    valueFormatter: (v: number) => (metric === 'cost' ? f.usd(v) : f.compact(v)),
  }))
  return (
    <BarChart
      series={series}
      xDomain={days}
      xScaleType="categorical"
      stackedBars
      height={260}
      ariaLabel={label}
      xTickFormatter={(d) => f.day(String(d))}
      yTickFormatter={(v) => (metric === 'cost' ? f.usd(v) : f.compact(v))}
      xTitle={t('caption.utcDays')}
      hideFilter={keys.length < 2}
      empty={t('state.empty.range')}
      noMatch={t('state.empty.filtered')}
    />
  )
}

/** One signed series per UTC day (net saving). */
export function DailyLine({ data, from, to, label, title }: { data: Array<{ day: string; v: number }>; from: string; to: string; label: string; title: string }) {
  const { f, t } = useI18n()
  const days = daysBetween(from, to)
  const byDay = new Map(data.map((d) => [d.day, d.v]))
  return (
    <BarChart
      series={[{ title, type: 'bar', data: days.map((d) => ({ x: d, y: byDay.get(d) ?? 0 })), valueFormatter: (v: number) => f.usdSigned(v) }]}
      xDomain={days}
      xScaleType="categorical"
      height={220}
      ariaLabel={label}
      xTickFormatter={(d) => f.day(String(d))}
      yTickFormatter={(v) => f.usdSigned(v)}
      xTitle={t('caption.utcDays')}
      hideFilter
      empty={t('state.empty.range')}
    />
  )
}

/** Health time series (several metrics on one time axis). */
export function TimeLines({ lines, label, format, height = 200 }: { lines: Array<{ title: string; data: Series[] }>; label: string; format: (v: number) => string; height?: number }) {
  const { locale } = useI18n()
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
  return (
    <LineChart
      series={lines.map((l) => ({ title: l.title, type: 'line' as const, data: l.data.map((p) => ({ x: new Date(p.t), y: p.v })), valueFormatter: format }))}
      xScaleType="time"
      height={height}
      ariaLabel={label}
      xTickFormatter={(d) => time.format(d as Date)}
      yTickFormatter={format}
      hideFilter={lines.length < 2}
    />
  )
}
