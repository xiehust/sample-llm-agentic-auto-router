import { describe, expect, it } from 'vitest'
import { TraceError, validateCall } from './schema.ts'
import { breakEvenCalls } from './synth.ts'

describe('validateCall', () => {
  const good = breakEvenCalls({ contextTokens: 30_000, steps: 1 })[1]!
  it('accepts a generated call', () => expect(validateCall(JSON.parse(JSON.stringify(good)))).toEqual(good))
  it('rejects segment sum mismatch', () => expect(() => validateCall({ ...good, promptTokens: good.promptTokens + 1 })).toThrow(/sum/))
  it('rejects unknown dialect, marker and bad numbers in one message', () => {
    const bad = { ...good, dialect: 'converse', markers: ['nope'], outputTokens: -1 }
    expect(() => validateCall(bad)).toThrow(TraceError)
    expect(() => validateCall(bad)).toThrow(/dialect.*outputTokens|outputTokens.*dialect/s)
  })
  it('rejects newTokens above promptTokens', () => expect(() => validateCall({ ...good, newTokens: good.promptTokens + 1 })).toThrow(/newTokens/))
  it('rejects non-objects', () => expect(() => validateCall('x')).toThrow(/not an object/))
})
