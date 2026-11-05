import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Ledger, scrub, scrubText } from './scrub.ts'

describe('scrub', () => {
  it('removes account ids, ARNs, provider ids, UUIDs and key ids', () => {
    const s = scrubText('acct 123456789012 arn:aws:bedrock:ap-northeast-1:123456789012:inference-profile/x resp_abcdef123 msg_ZZZZZZ9 '
      + '0f8fad5b-d9cb-469f-a165-70867728950e ' + 'AKIA' + 'ABCDEFGHIJKLMNOP') // built at runtime so secret scanners stay quiet
    expect(s).not.toMatch(/\d{12}/)
    expect(s).not.toMatch(/resp_|msg_|AKIA|arn:aws/)
    expect(s).toContain('ACCOUNT_SCRUBBED')
  })
  it('drops id keys deeply and keeps the rest', () => {
    const v = scrub({ id: 'resp_1234567', usage: { input_tokens: 3 }, nested: [{ request_id: 'x', text: 'ok 210987654321' }] })
    expect(v).toEqual({ usage: { input_tokens: 3 }, nested: [{ text: 'ok ACCOUNT_SCRUBBED' }] })
  })
})

describe('Ledger', () => {
  it('refuses a reservation that would cross the cap and persists spend', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.json')
    const l = new Ledger(path, 0.01)
    expect(l.reserve(0.004)).toBe(true)
    expect(l.reserve(0.004)).toBe(true)
    expect(l.reserve(0.004)).toBe(false) // pending 0.008 + 0.004 > 0.01
    l.settle(0.004, 0.001)
    l.settle(0.004, undefined) // unknown cost settles at the estimate
    expect(l.spentUsd).toBeCloseTo(0.005)
    expect(l.reserve(0.004)).toBe(true)
    l.settle(0.004, 0.004)
    expect(l.reserve(0.002)).toBe(false) // 0.009 + 0.002 > 0.01
    l.flush('test')
    const again = new Ledger(path, 0.01)
    expect(again.spentUsd).toBeCloseTo(0.009)
    expect(again.reserve(0.002)).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8')).entries).toHaveLength(1)
  })
})

describe('Ledger guards', () => {
  const tmpPath = () => join(mkdtempSync(join(tmpdir(), 'ledger-')), 'ledger.json')
  it('rejects a non-finite cap (NaN would let every reservation pass)', () => {
    expect(() => new Ledger(tmpPath(), Number('abc'))).toThrow(/cap/)
    expect(() => new Ledger(tmpPath(), Number.POSITIVE_INFINITY)).toThrow(/cap/)
  })
  it('rejects a malformed ledger file and invalid estimates', () => {
    const p = tmpPath()
    writeFileSync(p, JSON.stringify({ entries: [] }))
    expect(() => new Ledger(p, 1)).toThrow(/malformed/)
    const l = new Ledger(tmpPath(), 1)
    expect(l.reserve(Number.NaN)).toBe(false)
    expect(l.reserve(-1)).toBe(false)
  })
  it('books an invalid actual cost at the estimate and persists spend before flush', () => {
    const p = tmpPath()
    const l = new Ledger(p, 1)
    expect(l.reserve(0.01)).toBe(true)
    l.settle(0.01, Number.NaN)
    expect(l.spentUsd).toBeCloseTo(0.01)
    // A crash before flush() still leaves the spend on disk.
    expect(new Ledger(p, 1).spentUsd).toBeCloseTo(0.01)
    l.flush('run')
    const file = JSON.parse(readFileSync(p, 'utf8')) as { entries: Array<{ label: string; calls: number }> }
    expect(file.entries).toEqual([expect.objectContaining({ label: 'run', calls: 1 })])
  })
})

describe('scrub Bedrock ids', () => {
  it('removes ids that contain underscores (msg_bdrk_…, toolu_bdrk_…)', () => {
    const s = scrubText('id msg_bdrk_01AbCdEfGh tool toolu_bdrk_01XyZ123')
    expect(s).not.toMatch(/bdrk|01AbCd|01XyZ/)
  })
})
