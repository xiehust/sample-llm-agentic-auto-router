import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { I18nRoot, loadLocale } from '../../i18n/I18n.tsx'
import type { Locale } from '../../i18n/locale.ts'
import { createTranslator, loadMessages } from '../../i18n/messages.ts'
import { PrefsRoot } from '../../prefs/prefs.tsx'
import { EffectsList } from './Policy.tsx'

describe.each(['en', 'zh-CN'] as Locale[])('activation effects (%s)', (locale) => {
  it('shows cannot-compare as its own error with the copy and the detail', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    render(<PrefsRoot><I18nRoot initial={await loadLocale(locale)}>
      <EffectsList effects={[{ effect: 'cannot-compare', severity: 'disruptive', detail: 'policy.mode: invalid' }]} />
    </I18nRoot></PrefsRoot>)
    const box = await screen.findByTestId('effect-cannot-compare')
    expect(box.textContent).toContain(t('config.effects.cannotCompare'))
    expect(box.textContent).toContain('policy.mode: invalid')
  })
})

describe.each(['en', 'zh-CN'] as Locale[])('console-api effects (%s)', (locale) => {
  it('identity and assessor effects render the console copy with the English detail', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    render(<PrefsRoot><I18nRoot initial={await loadLocale(locale)}>
      <EffectsList effects={[
        { effect: 'identity-weakened', severity: 'disruptive', detail: 'identity require → observe' },
        { effect: 'identity-strengthened', severity: 'info', detail: 'identity off → observe' },
        { effect: 'assessor-mode', severity: 'warn', detail: 'assessor auto → observe' },
      ]} />
    </I18nRoot></PrefsRoot>)
    expect((await screen.findByTestId('effect-identity-weakened')).textContent).toContain(t('ext.effects.identityWeakened'))
    expect(screen.getByTestId('effect-identity-weakened').textContent).toContain('identity require → observe')
    expect(screen.getByTestId('effect-identity-strengthened').textContent).toContain(t('ext.effects.identityStrengthened'))
    expect(screen.getByTestId('effect-assessor-mode').textContent).toContain(t('ext.effects.assessorMode'))
  })
})
