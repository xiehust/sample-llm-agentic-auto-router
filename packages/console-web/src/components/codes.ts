// Labels for router codes from 73's decision-codes.json (keys are the contract; copy is 4f's). Lookup order: exact
// key in the group, first matching pattern, fallback — so a newer router never breaks an older console. Values are
// rendered as text, never HTML.

import table from '../i18n/decision-codes.json'
import type { Locale } from '../i18n/locale.ts'

export type Tone = 'neutral' | 'positive' | 'notice' | 'warning' | 'error'
interface Text { en: string; 'zh-CN': string }
interface Entry { label: Text; desc?: Text; tone?: Tone }
interface Table {
  fallback: Entry
  groups: Record<string, { label: Text; codes: Record<string, Entry> }>
  patterns: Array<{ group: string; match: string; label: Text; desc?: Text; tone?: Tone }>
  ruleTitles: Record<string, Text | string>
}

const T = table as unknown as Table
const compiled = T.patterns.map((p) => ({ ...p, re: new RegExp(p.match) }))

export interface CodeLabel { label: string; desc?: string; tone: Tone; known: boolean }

const fill = (s: string, caps: readonly string[], code: string) => s.replace(/\{(\d)\}/g, (_, i: string) => caps[Number(i)] ?? '').replace('{code}', code)

export function codeLabel(group: string, code: string, locale: Locale): CodeLabel {
  const e = T.groups[group]?.codes[code]
  if (e) return { label: e.label[locale], ...(e.desc ? { desc: e.desc[locale] } : {}), tone: e.tone ?? 'neutral', known: true }
  for (const p of compiled) {
    if (p.group !== group) continue
    const m = p.re.exec(code)
    if (m) return { label: fill(p.label[locale], m, code), ...(p.desc ? { desc: fill(p.desc[locale], m, code) } : {}), tone: p.tone ?? 'neutral', known: true }
  }
  return { label: fill(T.fallback.label[locale], [], code), ...(T.fallback.desc ? { desc: T.fallback.desc[locale] } : {}), tone: T.fallback.tone ?? 'notice', known: false }
}

export function ruleTitle(id: string, locale: Locale): string | undefined {
  const v = T.ruleTitles[id]
  return typeof v === 'object' ? v[locale] : undefined
}

/** Cloudscape StatusIndicator type for a tone. */
export const toneStatus = (tone: Tone): 'info' | 'success' | 'warning' | 'error' | 'stopped' =>
  tone === 'positive' ? 'success' : tone === 'warning' ? 'warning' : tone === 'error' ? 'error' : tone === 'notice' ? 'info' : 'stopped'
