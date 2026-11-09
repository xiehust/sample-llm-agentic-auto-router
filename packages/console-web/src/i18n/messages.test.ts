// Copy-deck parity (4f §7): same keys in en and zh-CN, every value valid ICU, the same arguments per key, no empty
// values, and the ext files (18's keys pending 4f) never collide with the deck.

import { IntlMessageFormat } from 'intl-messageformat'
import { describe, expect, it } from 'vitest'
import en from './messages/en.json'
import extEn from './messages/ext.en.json'
import extZh from './messages/ext.zh-CN.json'
import zh from './messages/zh-CN.json'
import { createTranslator, loadMessages } from './messages.ts'

type Dict = Record<string, string>
const deck: Array<[string, Dict, Dict]> = [['deck', en as Dict, zh as Dict], ['ext', extEn as Dict, extZh as Dict]]

/** Top-level argument names of an ICU message (plural/select branches included). */
function args(msg: string): string[] {
  const out = new Set<string>()
  const walk = (els: unknown[]) => {
    for (const e of els as Array<{ type: number; value?: string; options?: Record<string, { value: unknown[] }> }>) {
      if (e.type !== 0 && e.type !== 7 && typeof e.value === 'string') out.add(e.value)
      if (e.options) for (const o of Object.values(e.options)) walk(o.value)
    }
  }
  walk(new IntlMessageFormat(msg, 'en', undefined, { ignoreTag: true }).getAst() as unknown[])
  return [...out].sort()
}

describe('copy deck', () => {
  for (const [name, a, b] of deck) {
    it(`${name}: en and zh-CN have the same keys`, () => {
      expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort())
    })
    it(`${name}: every value is non-empty, valid ICU, with the same arguments in both languages`, () => {
      for (const k of Object.keys(a)) {
        expect(a[k]?.trim(), k).toBeTruthy()
        expect(b[k]?.trim(), k).toBeTruthy()
        expect(() => new IntlMessageFormat(a[k] as string, 'en', undefined, { ignoreTag: true }), `en ${k}`).not.toThrow()
        expect(() => new IntlMessageFormat(b[k] as string, 'zh-CN', undefined, { ignoreTag: true }), `zh-CN ${k}`).not.toThrow()
        expect(args(b[k] as string), k).toEqual(args(a[k] as string))
      }
    })
  }

  it('ext keys never shadow deck keys', () => {
    expect(Object.keys(extEn).filter((k) => k in en)).toEqual([])
  })

  it('formats plurals per locale (zh-CN uses other only)', async () => {
    const tEn = createTranslator('en', await loadMessages('en'))
    const tZh = createTranslator('zh-CN', await loadMessages('zh-CN'))
    expect(tEn('common.requests', { count: 1 })).toBe('1 request')
    expect(tEn('common.requests', { count: 3 })).toBe('3 requests')
    expect(tZh('common.requests', { count: 3 })).toBe('3 个请求')
  })

  it('keeps <…> in copy as literal text', async () => {
    const t = createTranslator('en', await loadMessages('en'))
    expect(t('term.pin')).toContain('pin=<model id>')
  })

  it('renders an unknown key as the key and never throws on a missing value', async () => {
    const t = createTranslator('en', await loadMessages('en'))
    expect(t('nope.missing' as never)).toBe('nope.missing')
    expect(() => t('app.deployment')).not.toThrow()
  })
})
