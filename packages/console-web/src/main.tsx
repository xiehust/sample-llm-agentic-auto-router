// Boot: preferences → language → /config.json → sign-in session → app (18-frontend-stack §2.5).

import '@cloudscape-design/global-styles/index.css'
import './styles.css'
import { createRoot } from 'react-dom/client'
import { StrictMode, type ReactNode } from 'react'
import { App } from './app/App.tsx'
import { CallbackErrorPage, ConfigErrorPage, SignedOutPage, SigningInPage } from './app/standalone.tsx'
import { AuthSession, takeSignedOutEverywhere } from './auth/session.ts'
import { SIGNED_OUT_PATH } from './auth/user-manager.ts'
import { loadRuntimeConfig } from './config/runtime-config.ts'
import { I18nRoot, loadLocale } from './i18n/I18n.tsx'
import { applyDocumentLang, initialLocale, type Locale } from './i18n/locale.ts'
import { applyPrefs, PrefsRoot, readPrefs } from './prefs/prefs.tsx'

async function boot(): Promise<void> {
  applyPrefs(readPrefs())
  const locale: Locale = initialLocale(globalThis.localStorage, navigator.languages ?? [navigator.language])
  applyDocumentLang(locale)
  const i18n = await loadLocale(locale)
  const root = createRoot(document.getElementById('root') as HTMLElement)
  const render = (node: ReactNode) => root.render(<StrictMode><PrefsRoot><I18nRoot initial={i18n}>{node}</I18nRoot></PrefsRoot></StrictMode>)
  const lang = () => document.documentElement.lang || locale

  let cfg
  try {
    cfg = await loadRuntimeConfig()
  } catch (e) {
    render(<ConfigErrorPage error={e} />)
    return
  }
  const session = new AuthSession(cfg)
  const signIn = (to: string) => { render(<SigningInPage />); void session.signIn(to, lang()) }

  if (location.pathname === SIGNED_OUT_PATH) {
    render(<SignedOutPage onSignIn={() => signIn('/')} everywhere={takeSignedOutEverywhere()} />)
    return
  }
  const r = await session.init()
  if (r.status === 'callback-error') {
    render(<CallbackErrorPage message={r.message} onSignIn={() => signIn('/')} />)
    return
  }
  if (r.status === 'signed-out') {
    signIn(location.pathname + location.search + location.hash)
    return
  }
  if (r.returnTo !== undefined) history.replaceState(null, '', r.returnTo)
  render(<App session={session} />)
}

void boot()
