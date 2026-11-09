// Typed dictionaries. en.json / zh-CN.json are 4f's copy deck (4f owns the wording; replace the files wholesale);
// ext.*.json holds keys 18 needed beyond the deck, for 4f to review and fold in. ICU MessageFormat via
// intl-messageformat, which Cloudscape's I18nProvider already bundles.

import { IntlMessageFormat } from 'intl-messageformat'
import type { Locale } from './locale.ts'

type Deck = typeof import('./messages/en.json')
type Ext = typeof import('./messages/ext.en.json')
export type MessageKey = Exclude<keyof Deck | keyof Ext, 'default'>
export type Messages = Record<MessageKey, string>
export type MessageValues = Record<string, string | number | Date>

const loaders: Record<Locale, () => Promise<[Record<string, string>, Record<string, string>]>> = {
  en: () => Promise.all([import('./messages/en.json'), import('./messages/ext.en.json')]).then(([a, b]) => [a.default, b.default]),
  'zh-CN': () => Promise.all([import('./messages/zh-CN.json'), import('./messages/ext.zh-CN.json')]).then(([a, b]) => [a.default, b.default]),
}

export async function loadMessages(locale: Locale): Promise<Messages> {
  const [deck, ext] = await loaders[locale]()
  return { ...ext, ...deck } as Messages
}

export type Translate = (key: MessageKey, values?: MessageValues) => string

/** A translator for one locale. Unknown keys render as the key; a broken message renders its raw text. */
export function createTranslator(locale: Locale, messages: Messages): Translate {
  const compiled = new Map<string, IntlMessageFormat | string>()
  return (key, values) => {
    let m = compiled.get(key)
    if (m === undefined) {
      const raw = (messages as Record<string, string | undefined>)[key]
      if (raw === undefined) return key
      // ignoreTag: copy is plain text; '<model id>' in a message is literal text, not a rich-text tag.
      try { m = raw.includes('{') ? new IntlMessageFormat(raw, locale, undefined, { ignoreTag: true }) : raw } catch { m = raw }
      compiled.set(key, m)
    }
    if (typeof m === 'string') return m
    try { return String(m.format(values ?? {})) } catch { return (messages as Record<string, string>)[key] ?? key }
  }
}

/** Cloudscape's own component strings for a locale (pagination, date picker, chart filters …). */
export async function loadCloudscapeMessages(locale: Locale): Promise<unknown> {
  return locale === 'zh-CN'
    ? (await import('@cloudscape-design/components/i18n/messages/all.zh-CN')).default
    : (await import('@cloudscape-design/components/i18n/messages/all.en')).default
}
