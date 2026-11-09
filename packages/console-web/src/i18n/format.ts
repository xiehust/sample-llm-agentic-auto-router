// Number, money and time formatting per locale (18-frontend-stack §3; 4f §7). Money is always list-price USD.

import type { Locale } from './locale.ts'

export interface Formatters {
  locale: Locale
  /** Totals: 2 decimals. */
  usd(v: number): string
  /** Single requests: up to 6 decimals (significant for tiny values). */
  usdPrecise(v: number): string
  /** Signed money (savings): an explicit sign for positive values. */
  usdSigned(v: number): string
  int(v: number): string
  /** Token counts in charts and KPIs (en 12.3M, zh-CN 1234.6万). */
  compact(v: number): string
  /** Fraction 0..1 → 1 decimal percent. */
  percent(v: number): string
  ms(v: number): string
  /** ISO timestamp → local or UTC date-time. */
  dateTime(iso: string, zone: 'local' | 'utc'): string
  /** UTC day 'YYYY-MM-DD' → short date label (always UTC). */
  day(day: string): string
  relative(iso: string, now?: number): string
}

const cache = new Map<string, Formatters>()

export function formatters(locale: Locale): Formatters {
  const hit = cache.get(locale)
  if (hit) return hit
  const usd2 = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const usd6 = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 })
  const usdSigned = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' })
  const int = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 })
  const pct = new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })
  const dtLocal = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' })
  const dtUtc = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' })
  const dayFmt = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const rel = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const msFmt = new Intl.NumberFormat(locale, { style: 'unit', unit: 'millisecond', unitDisplay: 'short', maximumFractionDigits: 0 })
  const f: Formatters = {
    locale,
    usd: (v) => usd2.format(v),
    usdPrecise: (v) => usd6.format(v),
    usdSigned: (v) => usdSigned.format(v),
    int: (v) => int.format(v),
    compact: (v) => compact.format(v),
    percent: (v) => pct.format(v),
    ms: (v) => msFmt.format(v),
    dateTime: (iso, zone) => {
      const d = new Date(iso)
      if (Number.isNaN(d.getTime())) return iso
      return zone === 'utc' ? `${dtUtc.format(d)} UTC` : dtLocal.format(d)
    },
    day: (day) => {
      const d = new Date(`${day}T00:00:00Z`)
      return Number.isNaN(d.getTime()) ? day : dayFmt.format(d)
    },
    relative: (iso, now = Date.now()) => {
      const s = Math.round((Date.parse(iso) - now) / 1000)
      const abs = Math.abs(s)
      if (abs < 60) return rel.format(s, 'second')
      if (abs < 3600) return rel.format(Math.round(s / 60), 'minute')
      if (abs < 86_400) return rel.format(Math.round(s / 3600), 'hour')
      return rel.format(Math.round(s / 86_400), 'day')
    },
  }
  cache.set(locale, f)
  return f
}
