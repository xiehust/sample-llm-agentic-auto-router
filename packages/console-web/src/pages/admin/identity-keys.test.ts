// The Require refusal reasons (73's IdentityKeysReason) in both locales.

import { describe, expect, it } from 'vitest'
import type { Locale } from '../../i18n/locale.ts'
import { createTranslator, loadMessages } from '../../i18n/messages.ts'
import { keysReasonText } from './DeploymentSettings.tsx'

describe.each(['en', 'zh-CN'] as Locale[])('keysReasonText (%s)', (locale) => {
  it('every reason has its own text; the task id is filled in; an unknown reason has none', async () => {
    const t = createTranslator(locale, await loadMessages(locale))
    const texts = (['no-fresh-task', 'partial', 'not-configured', 'task-without-keys'] as const).map((r) => keysReasonText(t, r, 'router/4d5e6f'))
    expect(new Set(texts).size).toBe(4)
    for (const x of texts) { expect(x).toBeTruthy(); expect(x).not.toMatch(/^ext\\./) }
    expect(texts[2]).toContain('router/4d5e6f')
    expect(texts[3]).toContain('router/4d5e6f')
    expect(keysReasonText(t, 'something-new', undefined)).toBeUndefined()
    expect(keysReasonText(t, undefined, undefined)).toBeUndefined()
  })
})
