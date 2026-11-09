// The data-page date range (4f §3.1): Last 24 hours, 7 days (default), 30 days, This month, Last month, Custom.
// Kept in the URL (?range=7d or ?from=YYYY-MM-DD&to=YYYY-MM-DD) so links can be shared. Days are UTC.

import DateRangePicker, { type DateRangePickerProps } from '@cloudscape-design/components/date-range-picker'
import Select from '@cloudscape-design/components/select'
import SpaceBetween from '@cloudscape-design/components/space-between'
import { isDay } from '@auto-router/console-contract'
import { useSearchParams } from 'react-router'
import { useI18n } from '../i18n/I18n.tsx'
import type { MessageKey } from '../i18n/messages.ts'

export type RangeKey = '24h' | '7d' | '30d' | 'thisMonth' | 'lastMonth' | 'custom'
const KEYS: readonly RangeKey[] = ['24h', '7d', '30d', 'thisMonth', 'lastMonth', 'custom']

export interface Range { key: RangeKey; from: string; to: string; fromIso: string; toIso: string }

const day = (t: number) => new Date(t).toISOString().slice(0, 10)

/**
 * Resolves the URL range. Query keys must stay stable between renders, so relative ranges end at the start of the
 * next UTC day (exclusive) and the 24-hour range starts on a 5-minute boundary, never at Date.now() itself.
 */
export function resolveRange(sp: URLSearchParams, now: number = Date.now(), fallback: RangeKey = '7d'): Range {
  const raw = sp.get('range')
  const from = sp.get('from')
  const to = sp.get('to')
  const dayMs = 86_400_000
  if (from && to && isDay(from) && isDay(to) && from <= to) {
    return { key: 'custom', from, to, fromIso: `${from}T00:00:00.000Z`, toIso: new Date(Date.parse(`${to}T00:00:00Z`) + dayMs).toISOString() }
  }
  const key: RangeKey = KEYS.includes(raw as RangeKey) && raw !== 'custom' ? (raw as RangeKey) : fallback
  const d = new Date(now)
  const today0 = Math.floor(now / dayMs) * dayMs
  const toIso = new Date(today0 + dayMs).toISOString()
  const since = (days: number) => ({ from: day(today0 - days * dayMs), to: day(now), fromIso: new Date(today0 - days * dayMs).toISOString(), toIso })
  switch (key) {
    case '24h': {
      const start = Math.floor((now - dayMs) / 300_000) * 300_000
      return { key, from: day(start), to: day(now), fromIso: new Date(start).toISOString(), toIso }
    }
    case '30d': return { key, ...since(29) }
    case 'thisMonth': {
      const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
      return { key, from: day(first), to: day(now), fromIso: new Date(first).toISOString(), toIso }
    }
    case 'lastMonth': {
      const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)
      const last = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)
      return { key, from: day(first), to: day(last), fromIso: new Date(first).toISOString(), toIso: new Date(last + dayMs).toISOString() }
    }
    default: return { key: '7d', ...since(6) }
  }
}

export function useRange(fallback: RangeKey = '7d'): [Range, (r: { key: RangeKey; from?: string; to?: string }) => void] {
  const [sp, setSp] = useSearchParams()
  const range = resolveRange(sp, Date.now(), fallback)
  const set = (r: { key: RangeKey; from?: string; to?: string }) => {
    setSp((cur) => {
      const n = new URLSearchParams(cur)
      n.delete('range'); n.delete('from'); n.delete('to'); n.delete('cursor')
      if (r.key === 'custom' && r.from && r.to) { n.set('from', r.from); n.set('to', r.to) } else if (r.key !== 'custom') n.set('range', r.key)
      return n
    }, { replace: true })
  }
  return [range, set]
}

const LABEL: Record<RangeKey, MessageKey> = {
  '24h': 'common.range.24h', '7d': 'common.range.7d', '30d': 'common.range.30d', thisMonth: 'common.range.thisMonth', lastMonth: 'common.range.lastMonth', custom: 'common.range.custom',
}

export function RangeControl({ range, onChange, keys = KEYS }: { range: Range; onChange: (r: { key: RangeKey; from?: string; to?: string }) => void; keys?: readonly RangeKey[] }) {
  const { t } = useI18n()
  const options = keys.map((k) => ({ value: k, label: t(LABEL[k]) }))
  const value: DateRangePickerProps.AbsoluteValue = { type: 'absolute', startDate: range.from, endDate: range.to }
  return (
    <SpaceBetween direction="horizontal" size="xs">
      <Select
        ariaLabel={t('common.dateRange')}
        selectedOption={options.find((o) => o.value === range.key) ?? null}
        options={options}
        onChange={(e) => {
          const k = e.detail.selectedOption.value as RangeKey
          onChange(k === 'custom' ? { key: 'custom', from: range.from, to: range.to } : { key: k })
        }}
      />
      {range.key === 'custom' && (
        <DateRangePicker
          rangeSelectorMode="absolute-only"
          dateOnly
          value={value}
          onChange={(e) => {
            const v = e.detail.value
            if (v?.type === 'absolute') onChange({ key: 'custom', from: v.startDate.slice(0, 10), to: v.endDate.slice(0, 10) })
          }}
          isValidRange={(v) => (v?.type === 'absolute' && v.startDate && v.endDate && v.startDate <= v.endDate ? { valid: true } : { valid: false, errorMessage: t('common.range.invalid') })}
          relativeOptions={[]}
          placeholder="YYYY/MM/DD — YYYY/MM/DD"
        />
      )}
    </SpaceBetween>
  )
}
