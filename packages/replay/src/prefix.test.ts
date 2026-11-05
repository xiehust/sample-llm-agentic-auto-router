import { describe, expect, it } from 'vitest'
import { BlockHasher, fnv1a64, sharedPrefix, truncateSegments } from './prefix.ts'

const S = (...xs: [string, number][]) => xs.map(([id, tokens]) => ({ id, tokens }))

describe('sharedPrefix', () => {
  it('append-only: previous prompt is a prefix', () => expect(sharedPrefix(S(['t', 10], ['a', 5]), S(['t', 10], ['a', 9]))).toBe(15))
  it('shorter intermediate segment ends the match', () => expect(sharedPrefix(S(['t', 10], ['a', 5], ['b', 3]), S(['t', 10], ['a', 7], ['b', 3]))).toBe(15))
  it('rewrite: diverges at the new segment', () => expect(sharedPrefix(S(['t', 10], ['a', 5], ['c', 4]), S(['t', 10], ['a', 9]))).toBe(15))
  it('disjoint lineages share only the template', () => expect(sharedPrefix(S(['t', 10], ['a', 5]), S(['t', 10], ['b', 5]))).toBe(10))
  it('different templates share nothing', () => expect(sharedPrefix(S(['t', 10]), S(['u', 10]))).toBe(0))
  it('truncate keeps a prefix', () => expect(truncateSegments(S(['t', 10], ['a', 5]), 12)).toEqual(S(['t', 10], ['a', 2])))
})

describe('BlockHasher', () => {
  it('extends hashes for append-only calls and is deterministic', () => {
    const h = new BlockHasher(4)
    const a = h.hashes('L', S(['t', 6], ['a', 6]))
    const b = h.hashes('L', S(['t', 6], ['a', 11]))
    expect(a).toHaveLength(3)
    expect(b).toHaveLength(4)
    expect(b.slice(0, 3)).toEqual(a)
    expect(new BlockHasher(4).hashes('X', S(['t', 6], ['a', 11]))).toEqual(b)
  })
  it('diverging content changes later block hashes only', () => {
    const h = new BlockHasher(4)
    const a = h.hashes('L', S(['t', 6], ['a', 6]))
    const c = h.hashes('L', S(['t', 6], ['a', 1], ['z', 5]))
    expect(c[0]).toBe(a[0])
    expect(c[1]).not.toBe(a[1])
  })
  it('fnv1a64 is 16 hex chars and input-sensitive', () => {
    expect(fnv1a64('a')).toMatch(/^[0-9a-f]{16}$/)
    expect(fnv1a64('a')).not.toBe(fnv1a64('b'))
  })
})
