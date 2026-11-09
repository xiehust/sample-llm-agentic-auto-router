// Query-string codec shared by the SPA and the API. Arrays are comma-separated (values never contain commas: ids,
// codes and model ids), booleans are 'true'/'false', absent or empty values are omitted.

export type QueryValue = string | number | boolean | readonly string[] | undefined | null

export function toQuery(q: Readonly<Record<string, QueryValue>>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) { if (v.length > 0) sp.set(k, v.join(',')) } else sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export const qList = (sp: URLSearchParams, k: string): string[] | undefined => {
  const v = sp.get(k)
  if (v === null || v === '') return undefined
  return v.split(',').filter((x) => x !== '')
}

export const qBool = (sp: URLSearchParams, k: string): boolean | undefined => {
  const v = sp.get(k)
  return v === 'true' ? true : v === 'false' ? false : undefined
}

export const qStr = (sp: URLSearchParams, k: string): string | undefined => {
  const v = sp.get(k)
  return v === null || v === '' ? undefined : v
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
/** A valid UTC calendar day 'YYYY-MM-DD'. */
export function isDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DAY.test(v)) return false
  const d = new Date(`${v}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v
}

/** Every UTC day from..to inclusive (empty when from > to). */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = []
  const end = Date.parse(`${to}T00:00:00Z`)
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10))
  return out
}

export const principalKey = (kind: 'user' | 'client' | 'none', id?: string): string => (kind === 'none' ? 'none' : `${kind}:${id ?? ''}`)
