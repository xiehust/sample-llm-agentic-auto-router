// Decision actions use the deck's terms (4f: Pin / 指定, not the code table's Pinned / 固定); other codes fall back to the code table.

import { describe, expect, it } from 'vitest'
import type { Locale } from '../i18n/locale.ts'
import { createTranslator, loadMessages } from '../i18n/messages.ts'
import { codeLabel } from '../components/codes.ts'
import { actionLabel } from './decisions-common.tsx'

describe.each(['en', 'zh-CN'] as Locale[])('actionLabel (%s)', (locale) => {
  it('the four actions read as enum.action.*; an unknown code uses the code table', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    for (const a of ['initialize', 'retain', 'switch', 'pin'] as const) expect(actionLabel(t, a, locale)).toBe(t(`enum.action.${a}`))
    expect(actionLabel(t, 'pin', locale)).toBe(locale === 'en' ? 'Pin' : '指定')
    expect(actionLabel(t, 'something-new', locale)).toBe(codeLabel('decision.action', 'something-new', locale).label)
  })
})
