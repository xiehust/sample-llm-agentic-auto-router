import { I18nProvider as CloudscapeI18n } from '@cloudscape-design/components/i18n'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { formatters, type Formatters } from './format.ts'
import { applyDocumentLang, persistLocale, type Locale } from './locale.ts'
import { createTranslator, loadCloudscapeMessages, loadMessages, type Messages, type Translate } from './messages.ts'

export interface I18n {
  locale: Locale
  t: Translate
  f: Formatters
  setLocale(l: Locale): void
}

const Ctx = createContext<I18n | undefined>(undefined)

export function useI18n(): I18n {
  const v = useContext(Ctx)
  if (!v) throw new Error('useI18n outside <I18nRoot>')
  return v
}

interface Loaded { locale: Locale; messages: Messages; cloudscape: unknown }

export async function loadLocale(locale: Locale): Promise<Loaded> {
  const [messages, cloudscape] = await Promise.all([loadMessages(locale), loadCloudscapeMessages(locale)])
  return { locale, messages, cloudscape }
}

/** Provides our strings and Cloudscape's for the active locale; switching loads the other locale lazily. */
export function I18nRoot({ initial, children }: { initial: Loaded; children: ReactNode }) {
  const [loaded, setLoaded] = useState<Loaded>(initial)
  useEffect(() => { applyDocumentLang(loaded.locale) }, [loaded.locale])
  const setLocale = useCallback((l: Locale) => {
    persistLocale(globalThis.localStorage, l)
    void loadLocale(l).then(setLoaded)
  }, [])
  const value = useMemo<I18n>(() => ({
    locale: loaded.locale,
    t: createTranslator(loaded.locale, loaded.messages),
    f: formatters(loaded.locale),
    setLocale,
  }), [loaded, setLocale])
  return (
    <Ctx.Provider value={value}>
      {/* Cloudscape's messages type is its own; the loaded module matches it. */}
      <CloudscapeI18n locale={loaded.locale} messages={[loaded.cloudscape as never]}>{children}</CloudscapeI18n>
    </Ctx.Provider>
  )
}
