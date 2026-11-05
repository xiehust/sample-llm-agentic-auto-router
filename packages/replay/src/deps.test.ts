import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as core from '@auto-router/core'
import * as pricing from '@auto-router/pricing'

describe('integration guard', () => {
  it('pricing is the real package', () => expect(typeof pricing.costOf).toBe('function'))
  it('stubs are deleted once @auto-router/core exports createEngine', () => {
    const coreLanded = typeof (core as Record<string, unknown>).createEngine === 'function'
    if (coreLanded) expect(existsSync(new URL('./_stubs', import.meta.url))).toBe(false)
  })
})
