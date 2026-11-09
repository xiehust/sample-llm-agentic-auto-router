// Locale selection and persistence. Preferences are the only thing the SPA keeps in localStorage (design §4: no
// tokens or credentials there).

export const LOCALES = ['en', 'zh-CN'] as const
export type Locale = (typeof LOCALES)[number]

export const LANG_KEY = 'llmar.console.lang'

export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v)

/** Stored choice, else zh-CN when the browser prefers any Chinese, else en. */
export function initialLocale(storage: Pick<Storage, 'getItem'> | undefined, languages: readonly string[]): Locale {
  try {
    const stored = storage?.getItem(LANG_KEY)
    if (isLocale(stored)) return stored
  } catch { /* storage blocked */ }
  return languages.some((l) => l.toLowerCase().startsWith('zh')) ? 'zh-CN' : 'en'
}

export function persistLocale(storage: Pick<Storage, 'setItem'> | undefined, l: Locale): void {
  try { storage?.setItem(LANG_KEY, l) } catch { /* storage blocked: the choice lasts for this page */ }
}

/** <html lang> drives CJK glyph selection (Han unification), so it must follow the UI language. */
export function applyDocumentLang(l: Locale, doc: Document = document): void {
  doc.documentElement.lang = l
}
