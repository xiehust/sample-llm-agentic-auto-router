// UI preferences in localStorage (non-sensitive; design §4 forbids only tokens and credentials there): theme,
// density and time display. Language lives in i18n/locale.ts.

import { applyDensity, applyMode, Density, Mode } from '@cloudscape-design/global-styles'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Theme = 'system' | 'light' | 'dark'
export type DensityPref = 'comfortable' | 'compact'
export type TimeDisplay = 'local' | 'utc'

export interface Prefs { theme: Theme; density: DensityPref; time: TimeDisplay }

const KEY = 'llmar.console.prefs'
const DEFAULTS: Prefs = { theme: 'system', density: 'comfortable', time: 'local' }

export function readPrefs(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Prefs {
  try {
    const v = JSON.parse(storage?.getItem(KEY) ?? '{}') as Partial<Prefs>
    return {
      theme: v.theme === 'light' || v.theme === 'dark' || v.theme === 'system' ? v.theme : DEFAULTS.theme,
      density: v.density === 'compact' ? 'compact' : 'comfortable',
      time: v.time === 'utc' ? 'utc' : 'local',
    }
  } catch { return DEFAULTS }
}

function writePrefs(p: Prefs): void {
  try { globalThis.localStorage?.setItem(KEY, JSON.stringify(p)) } catch { /* storage blocked */ }
}

const prefersDark = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true

export function applyPrefs(p: Prefs): void {
  const dark = p.theme === 'dark' || (p.theme === 'system' && prefersDark())
  applyMode(dark ? Mode.Dark : Mode.Light)
  applyDensity(p.density === 'compact' ? Density.Compact : Density.Comfortable)
}

interface PrefsCtx { prefs: Prefs; set(p: Partial<Prefs>): void }
const Ctx = createContext<PrefsCtx | undefined>(undefined)

export function PrefsRoot({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(() => readPrefs())
  useEffect(() => {
    applyPrefs(prefs)
    if (prefs.theme !== 'system' || typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = () => applyPrefs(prefs)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [prefs])
  const set = useCallback((p: Partial<Prefs>) => setPrefs((cur) => { const next = { ...cur, ...p }; writePrefs(next); return next }), [])
  const value = useMemo(() => ({ prefs, set }), [prefs, set])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePrefs(): PrefsCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('usePrefs outside <PrefsRoot>')
  return v
}
